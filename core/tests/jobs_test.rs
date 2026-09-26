//! Job queue tests (§77): states, retries, backoff, restart recovery.

use sovereign_core::jobs;
use sovereign_core::storage::db;

fn conn() -> rusqlite::Connection {
    let dir = std::env::temp_dir().join(format!(
        "sv-jobs-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    db::open(&dir).unwrap()
}

#[test]
fn enqueue_dequeue_complete_cycle() {
    let c = conn();
    let id = jobs::enqueue(&c, jobs::JobKind::IndexNote, serde_json::json!({"path": "A.md"})).unwrap();

    let job = jobs::dequeue(&c).unwrap().expect("job available");
    assert_eq!(job.id, id);
    assert_eq!(job.kind, jobs::JobKind::IndexNote);
    assert_eq!(job.payload["path"], "A.md");
    assert_eq!(job.attempts, 1);

    jobs::complete(&c, &job.id).unwrap();
    assert!(jobs::dequeue(&c).unwrap().is_none(), "queue drained");
    let stats = jobs::stats(&c).unwrap();
    assert_eq!(stats.completed, 1);
}

#[test]
fn fifo_ordering() {
    let c = conn();
    let a = jobs::enqueue(&c, jobs::JobKind::IndexNote, serde_json::json!(1)).unwrap();
    let b = jobs::enqueue(&c, jobs::JobKind::HealthScan, serde_json::json!(2)).unwrap();
    assert_eq!(jobs::dequeue(&c).unwrap().unwrap().id, a);
    assert_eq!(jobs::dequeue(&c).unwrap().unwrap().id, b);
}

#[test]
fn failures_retry_with_backoff_then_park() {
    let c = conn();
    let id = jobs::enqueue(&c, jobs::JobKind::IndexNote, serde_json::json!({})).unwrap();

    // Attempts 1..2 go back to pending with run_after in the future.
    let job = jobs::dequeue(&c).unwrap().unwrap();
    jobs::fail(&c, &job.id, "boom").unwrap();
    let pending: i64 = c
        .query_row("SELECT COUNT(*) FROM jobs WHERE status='pending' AND run_after > 0", [], |r| r.get(0))
        .unwrap();
    assert_eq!(pending, 1, "requeued with backoff");

    // Force the backoff window to pass, dequeue again (attempts=2), fail again.
    c.execute("UPDATE jobs SET run_after = 0", []).unwrap();
    let job = jobs::dequeue(&c).unwrap().unwrap();
    assert_eq!(job.attempts, 2);
    jobs::fail(&c, &job.id, "boom").unwrap();
    c.execute("UPDATE jobs SET run_after = 0", []).unwrap();

    // Third failure exhausts max_attempts → failed (parked, not requeued).
    let job = jobs::dequeue(&c).unwrap().unwrap();
    assert_eq!(job.attempts, 3);
    jobs::fail(&c, &job.id, "boom").unwrap();
    let stats = jobs::stats(&c).unwrap();
    assert_eq!(stats.failed, 1);
    assert!(jobs::dequeue(&c).unwrap().is_none());
    let error: Option<String> = c
        .query_row("SELECT last_error FROM jobs WHERE id = ?1", [&id], |r| r.get(0))
        .unwrap();
    assert_eq!(error.as_deref(), Some("boom"));
}

#[test]
fn orphaned_running_jobs_recover_on_startup() {
    let dir = std::env::temp_dir().join(format!(
        "sv-jobs-recover-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();

    {
        let c = db::open(&dir).unwrap();
        jobs::enqueue(&c, jobs::JobKind::IndexNote, serde_json::json!({})).unwrap();
        let job = jobs::dequeue(&c).unwrap().unwrap();
        // Simulate crash while running: just drop the connection.
        drop(job);
    }
    {
        let c = db::open(&dir).unwrap();
        let recovered = jobs::recover_orphans(&c).unwrap();
        assert_eq!(recovered, 1);
        // The job is runnable again after recovery.
        assert!(jobs::dequeue(&c).unwrap().is_some());
    }
}

#[test]
fn unknown_job_kind_never_panics() {
    let c = conn();
    c.execute(
        "INSERT INTO jobs (id, kind, payload, status, created_at) VALUES ('j1', 'mystery_kind', '{}', 'pending', 0)",
        [],
    )
    .unwrap();
    let job = jobs::dequeue(&c).unwrap().unwrap();
    // Unknown kinds map to IndexNote rather than crashing the worker.
    assert_eq!(job.kind, jobs::JobKind::IndexNote);
}
