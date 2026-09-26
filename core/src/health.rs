//! Brain health engine (PLAN.md §68): scans derived state and reports
//! actionable findings. It NEVER modifies anything destructive (§68: "must
//! not make destructive changes automatically") — detection only.

use crate::knowledge::find_duplicates;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// One health finding (§68: suggestions, not actions).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Finding {
    pub kind: String,
    pub path: String,
    pub detail: String,
}

/// Full health summary (§68 detection list; UI §25 renders categories).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct HealthSummary {
    pub total_notes: i64,
    pub total_chunks: i64,
    pub total_entities: i64,
    pub total_claims: i64,
    pub broken_links: Vec<Finding>,
    pub orphan_notes: Vec<Finding>,
    pub duplicate_candidates: Vec<DuplicateDto>,
    pub failed_jobs: i64,
    pub pending_jobs: i64,
}

/// Duplicate pair as delivered over the protocol (§69 output shape).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DuplicateDto {
    pub note_a: String,
    pub note_b: String,
    pub similarity: f64,
    pub reason: String,
}

/// Run all health checks against the database.
pub fn summary(conn: &Connection) -> Result<HealthSummary, rusqlite::Error> {
    let mut s = HealthSummary::default();

    s.total_notes = count(conn, "SELECT COUNT(*) FROM notes WHERE status = 'active'")?;
    s.total_chunks = count(conn, "SELECT COUNT(*) FROM chunks")?;
    s.total_entities = count(conn, "SELECT COUNT(*) FROM entities")?;
    s.total_claims = count(conn, "SELECT COUNT(*) FROM claims")?;
    s.failed_jobs = count(conn, "SELECT COUNT(*) FROM jobs WHERE status = 'failed'")?;
    s.pending_jobs = count(conn, "SELECT COUNT(*) FROM jobs WHERE status = 'pending'")?;

    // Broken links: link target matched no note (§68).
    let mut stmt = conn.prepare(
        "SELECT nl.note_id, nl.target, n.path
         FROM note_links nl
         JOIN notes n ON n.id = nl.note_id
         WHERE nl.resolved_note_id IS NULL AND n.status = 'active'",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Finding {
            kind: "broken_link".to_string(),
            path: r.get::<_, String>(2)?,
            detail: r.get::<_, String>(1)?,
        })
    })?;
    for row in rows {
        s.broken_links.push(row?);
    }

    // Orphan notes: no inbound links, no outbound links (§68). Personal-vault
    // scale makes a single grouped query fine (§93).
    let mut stmt = conn.prepare(
        "SELECT n.path FROM notes n
         WHERE n.status = 'active'
           AND NOT EXISTS (SELECT 1 FROM note_links nl WHERE nl.note_id = n.id)
           AND NOT EXISTS (SELECT 1 FROM note_links nl2 WHERE nl2.resolved_note_id = n.id)
           AND (SELECT COUNT(*) FROM notes) > 1",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Finding {
            kind: "orphan".to_string(),
            path: r.get::<_, String>(0)?,
            detail: "no links in or out".to_string(),
        })
    })?;
    for row in rows {
        s.orphan_notes.push(row?);
    }

    // Duplicates (§69): exact-hash candidates from the knowledge layer.
    let dupes = find_duplicates(conn)?;
    s.duplicate_candidates = dupes
        .into_iter()
        .map(|d| DuplicateDto {
            note_a: d.note_a,
            note_b: d.note_b,
            similarity: d.similarity,
            reason: d.reason.to_string(),
        })
        .collect();

    // Memory review counts ride on the summary (§25: Review Needed counts).
    s.pending_jobs = count(
        conn,
        "SELECT COUNT(*) FROM jobs WHERE status = 'pending'",
    )? + count(
        conn,
        "SELECT COUNT(*) FROM memories WHERE status = 'candidate'",
    )?;

    Ok(s)
}

/// Per-note detail: is this note excluded/broken/etc. (future UI §17).
pub fn note_health(conn: &Connection, path: &str) -> Result<Option<i64>, rusqlite::Error> {
    conn.query_row(
        "SELECT (SELECT COUNT(*) FROM chunks c JOIN notes n ON n.id = c.note_id WHERE n.path = ?1) as chunk_count",
        params![path],
        |r| r.get(0),
    )
    .optional()
}

fn count(conn: &Connection, sql: &str) -> Result<i64, rusqlite::Error> {
    conn.query_row(sql, [], |r| r.get(0))
}
