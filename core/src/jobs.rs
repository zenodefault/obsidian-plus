//! SQLite-backed job queue (PLAN.md §77): background work that survives
//! restarts. States: pending → running → completed | failed | cancelled.
//! On startup, orphaned `running` jobs return to `pending` (resume safely).

use rusqlite::{params, Connection, OptionalExtension};

/// Known job kinds (§77).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobKind {
    IndexNote,
    DeleteNoteIndex,
    RebuildIndex,
    HealthScan,
}

impl JobKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            JobKind::IndexNote => "index_note",
            JobKind::DeleteNoteIndex => "delete_note_index",
            JobKind::RebuildIndex => "rebuild_index",
            JobKind::HealthScan => "health_scan",
        }
    }

    fn from_str(s: &str) -> Option<Self> {
        match s {
            "index_note" => Some(JobKind::IndexNote),
            "delete_note_index" => Some(JobKind::DeleteNoteIndex),
            "rebuild_index" => Some(JobKind::RebuildIndex),
            "health_scan" => Some(JobKind::HealthScan),
            _ => None,
        }
    }
}

/// One dequeued job.
#[derive(Debug, Clone, PartialEq)]
pub struct Job {
    pub id: String,
    pub kind: JobKind,
    pub payload: serde_json::Value,
    pub attempts: i64,
}

/// Enqueue a job. Returns its id.
pub fn enqueue(
    conn: &Connection,
    kind: JobKind,
    payload: serde_json::Value,
) -> Result<String, rusqlite::Error> {
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO jobs (id, kind, payload, status, created_at) VALUES (?1, ?2, ?3, 'pending', ?4)",
        params![id, kind.as_str(), payload.to_string(), now_millis()],
    )?;
    Ok(id)
}

/// Dequeue the next runnable job (FIFO within priority by kind age), marking
/// it running. Returns None when the queue is drained.
pub fn dequeue(conn: &Connection) -> Result<Option<Job>, rusqlite::Error> {
    let row = conn
        .query_row(
            "SELECT id, kind, payload, attempts FROM jobs
             WHERE status = 'pending' AND run_after <= ?1
             ORDER BY created_at LIMIT 1",
            params![now_millis()],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?;
    let Some((id, kind, payload, attempts)) = row else {
        return Ok(None);
    };
    conn.execute(
        "UPDATE jobs SET status = 'running', started_at = ?2, attempts = attempts + 1 WHERE id = ?1",
        params![id, now_millis()],
    )?;
    Ok(Some(Job {
        id,
        kind: JobKind::from_str(&kind).unwrap_or(JobKind::IndexNote),
        payload: serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null),
        attempts: attempts + 1,
    }))
}

/// Mark a job completed.
pub fn complete(conn: &Connection, job_id: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE jobs SET status = 'completed', finished_at = ?2 WHERE id = ?1",
        params![job_id, now_millis()],
    )?;
    Ok(())
}

/// Mark a job failed; retries with linear backoff until max_attempts, then
/// parks it as `failed` for inspection (§77: resume safely after restart).
pub fn fail(
    conn: &Connection,
    job_id: &str,
    error: &str,
) -> Result<(), rusqlite::Error> {
    let attempts: i64 = conn.query_row(
        "SELECT attempts FROM jobs WHERE id = ?1",
        params![job_id],
        |r| r.get(0),
    )?;
    let max: i64 = conn.query_row(
        "SELECT max_attempts FROM jobs WHERE id = ?1",
        params![job_id],
        |r| r.get(0),
    )?;
    if attempts >= max {
        conn.execute(
            "UPDATE jobs SET status = 'failed', last_error = ?2, finished_at = ?3 WHERE id = ?1",
            params![job_id, error, now_millis()],
        )?;
    } else {
        let backoff_ms = 1_000 * attempts; // linear backoff
        conn.execute(
            "UPDATE jobs SET status = 'pending', run_after = ?2, last_error = ?3 WHERE id = ?1",
            params![job_id, now_millis() + backoff_ms, error],
        )?;
    }
    Ok(())
}

/// Startup recovery: return orphaned `running` jobs to the queue (§77).
pub fn recover_orphans(conn: &Connection) -> Result<u64, rusqlite::Error> {
    let n = conn.execute(
        "UPDATE jobs SET status = 'pending', started_at = NULL WHERE status = 'running'",
        [],
    )?;
    Ok(n as u64)
}

/// Queue statistics for health surfaces.
#[derive(Debug, Clone, PartialEq)]
pub struct QueueStats {
    pub pending: i64,
    pub running: i64,
    pub failed: i64,
    pub completed: i64,
}

pub fn stats(conn: &Connection) -> Result<QueueStats, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END),
            SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END),
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END),
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)
         FROM jobs",
    )?;
    stmt.query_row([], |r| {
        Ok(QueueStats {
            pending: r.get::<_, Option<i64>>(0)?.unwrap_or(0),
            running: r.get::<_, Option<i64>>(1)?.unwrap_or(0),
            failed: r.get::<_, Option<i64>>(2)?.unwrap_or(0),
            completed: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
        })
    })
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
