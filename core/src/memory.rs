//! Memory engine (PLAN.md §49–55, §108–109).
//!
//! Memory is a persistent, reviewable representation of user context — not
//! retrieved text (§49). Candidates come only from typed claims with the
//! right epistemic status; hypotheses and questions NEVER become memories
//! (§51 false-memory prevention). Every memory carries provenance (§52).
//! Detection never destroys: stale/superseded are states, not deletions.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Memory types (§49, §14).
pub const MEMORY_TYPES: &[&str] = &["goal", "preference", "decision", "experience"];

/// Claim types eligible to become memory candidates are enforced by
/// `memory_type_for` below: DECISION/PREFERENCE/GOAL/EXPERIENCE only. FACT is
/// excluded (context, not user context); HYPOTHESIS/QUESTION excluded
/// (uncertainty is not memory) — the §51 false-memory guard.

/// A memory row as delivered over the protocol (§52 shape).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MemoryEntry {
    pub id: String,
    #[serde(rename = "type")]
    pub memory_type: String,
    pub content: String,
    pub status: String,
    pub confidence: f64,
    pub user_verified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_from: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_until: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub sources: Vec<MemorySource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MemorySource {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<String>,
}

/// Strip wiki markup for display content while provenance keeps the original.
fn clean_content(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '[' && chars.peek() == Some(&'[') {
            chars.next();
            // Skip to the closing ]] capturing the target.
            let mut target = String::new();
            let mut closed = false;
            while let Some(inner) = chars.next() {
                if inner == ']' {
                    if chars.peek() == Some(&']') {
                        chars.next();
                        closed = true;
                        break;
                    }
                    target.push(inner);
                } else {
                    target.push(inner);
                }
            }
            if closed {
                // [[Note#sec|alias]] → Note (or alias).
                let main = target.split('#').next().unwrap_or(&target);
                let shown = main.split('|').next_back().unwrap_or(main);
                out.push_str(shown.trim());
                continue;
            }
            out.push_str("[[");
            out.push_str(&target);
            continue;
        }
        out.push(c);
    }
    out.trim().to_string()
}

/// Map a claim to memory type; None when the claim type is not memory-worthy.
fn memory_type_for(claim_type: &str) -> Option<&'static str> {
    match claim_type {
        "DECISION" => Some("decision"),
        "PREFERENCE" => Some("preference"),
        "GOAL" => Some("goal"),
        "EXPERIENCE" => Some("experience"),
        _ => None,
    }
}

/// Generate memory candidates from a note's freshly persisted claims (§50:
/// Source → Claim → Candidate). Deduplicates by (note, content): re-indexing
/// the same note updates the provenance claim link instead of duplicating —
/// accepted memories survive re-indexing (§90).
pub fn generate_candidates_for_note(
    conn: &Connection,
    note_id: &str,
    claim_ids: &[(String, String, String, String)], // (id, type, object, polarity)
    now: i64,
) -> Result<usize, rusqlite::Error> {
    let mut created = 0usize;
    for (claim_id, claim_type, object, polarity) in claim_ids {
        let Some(memory_type) = memory_type_for(claim_type) else {
            continue;
        };
        let content = clean_content(object);
        if content.is_empty() {
            continue;
        }
        // Dedup: same note + same content already produced a memory.
        let existing: Option<String> = conn
            .query_row(
                "SELECT m.id FROM memories m
                 JOIN memory_sources ms ON ms.memory_id = m.id
                 WHERE ms.note_id = ?1 AND m.content = ?2 LIMIT 1",
                params![note_id, content],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(memory_id) = existing {
            // Re-link provenance to the fresh claim id (old claim was replaced
            // by re-extraction), keep the memory's review state.
            conn.execute(
                "UPDATE memory_sources SET claim_id = ?2, excerpt = ?3
                 WHERE memory_id = ?1 AND note_id = ?4",
                params![memory_id, claim_id, object, note_id],
            )?;
            continue;
        }
        let memory_id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO memories (id, type, content, status, confidence, user_verified, valid_from, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'candidate', 0.8, 0, ?4, ?4, ?4)",
            params![memory_id, memory_type, content, now],
        )?;
        // Negated memories: provenance keeps the sentence verbatim; polarity
        // rides on the claim (§51: uncertainty and negation are preserved).
        conn.execute(
            "INSERT OR IGNORE INTO memory_sources (memory_id, note_id, claim_id, excerpt)
             VALUES (?1, ?2, ?3, ?4)",
            params![memory_id, note_id, claim_id, object],
        )?;
        let _ = polarity;
        created += 1;
    }
    Ok(created)
}

/// Load one memory with sources.
fn load_entry(conn: &Connection, id: &str) -> Result<Option<MemoryEntry>, rusqlite::Error> {
    let row = conn
        .query_row(
            "SELECT id, type, content, status, confidence, user_verified, valid_from, valid_until, created_at, updated_at
             FROM memories WHERE id = ?1",
            params![id],
            |r| {
                Ok(MemoryEntry {
                    id: r.get(0)?,
                    memory_type: r.get(1)?,
                    content: r.get(2)?,
                    status: r.get(3)?,
                    confidence: r.get(4)?,
                    user_verified: r.get::<_, i64>(5)? != 0,
                    valid_from: r.get(6)?,
                    valid_until: r.get(7)?,
                    created_at: r.get(8)?,
                    updated_at: r.get(9)?,
                    sources: Vec::new(),
                })
            },
        )
        .optional()?;
    let Some(mut entry) = row else {
        return Ok(None);
    };
    entry.sources = load_sources(conn, id)?;
    Ok(Some(entry))
}

fn load_sources(conn: &Connection, memory_id: &str) -> Result<Vec<MemorySource>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT ms.note_id, n.path, ms.claim_id, ms.excerpt
         FROM memory_sources ms
         LEFT JOIN notes n ON n.id = ms.note_id
         WHERE ms.memory_id = ?1",
    )?;
    let rows = stmt.query_map(params![memory_id], |r| {
        Ok(MemorySource {
            note_id: r.get(0)?,
            note_path: r.get(1)?,
            claim_id: r.get(2)?,
            excerpt: r.get(3)?,
        })
    })?;
    rows.collect()
}

/// `memory.list` — optionally filtered by status; runs stale detection first
/// (§55) so the list always reflects reality.
pub fn list(conn: &Connection, status: Option<&str>) -> Result<Vec<MemoryEntry>, rusqlite::Error> {
    mark_stale_memories(conn)?;
    let sql = match status {
        Some(_) => {
            "SELECT id FROM memories WHERE status = ?1 ORDER BY updated_at DESC"
        }
        None => "SELECT id FROM memories ORDER BY updated_at DESC",
    };
    let mut stmt = conn.prepare(sql)?;
    let ids: Vec<String> = match status {
        Some(s) => stmt
            .query_map(params![s], |r| r.get(0))?
            .collect::<Result<_, _>>()?,
        None => stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?,
    };
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(entry) = load_entry(conn, &id)? {
            out.push(entry);
        }
    }
    Ok(out)
}

/// `memory.accept` — user confirms (§50: User Review → Accepted Memory).
pub fn accept(conn: &Connection, id: &str) -> Result<MemoryEntry, MemoryApiError> {
    transition(conn, id, &["candidate", "stale", "disputed"], "accepted", true)
}

/// `memory.reject`.
pub fn reject(conn: &Connection, id: &str) -> Result<MemoryEntry, MemoryApiError> {
    transition(conn, id, &["candidate", "stale", "disputed"], "rejected", false)
}

/// `memory.update` — user edits content/type; verification stays as-is.
pub fn update(
    conn: &Connection,
    id: &str,
    content: Option<&str>,
    memory_type: Option<&str>,
) -> Result<MemoryEntry, MemoryApiError> {
    let now = now_millis();
    if let Some(t) = memory_type {
        if !MEMORY_TYPES.contains(&t) {
            return Err(MemoryApiError::Invalid(format!("unknown memory type: {t}")));
        }
        conn.execute(
            "UPDATE memories SET type = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, t, now],
        )
        .map_err(MemoryApiError::Db)?;
    }
    if let Some(c) = content {
        if c.trim().is_empty() {
            return Err(MemoryApiError::Invalid("content must not be empty".into()));
        }
        conn.execute(
            "UPDATE memories SET content = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, c.trim(), now],
        )
        .map_err(MemoryApiError::Db)?;
    }
    load_entry(conn, id)?
        .ok_or_else(|| MemoryApiError::NotFound(id.to_string()))
}

/// `memory.supersede` (§109): the old memory becomes superseded
/// (valid_until = now), a new accepted memory carries the current statement
/// with provenance inherited from the old one's sources.
pub fn supersede(
    conn: &Connection,
    old_id: &str,
    new_content: &str,
    new_type: Option<&str>,
) -> Result<MemoryEntry, MemoryApiError> {
    let now = now_millis();
    let old = load_entry(conn, old_id)?.ok_or_else(|| MemoryApiError::NotFound(old_id.to_string()))?;
    if old.status == "rejected" {
        return Err(MemoryApiError::Invalid(
            "cannot supersede a rejected memory".into(),
        ));
    }
    if new_content.trim().is_empty() {
        return Err(MemoryApiError::Invalid("content must not be empty".into()));
    }
    let memory_type = new_type
        .map(str::to_string)
        .unwrap_or_else(|| old.memory_type.clone());
    if !MEMORY_TYPES.contains(&memory_type.as_str()) {
        return Err(MemoryApiError::Invalid(format!(
            "unknown memory type: {memory_type}"
        )));
    }

    let tx = conn.unchecked_transaction().map_err(MemoryApiError::Db)?;
    let new_id = uuid::Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO memories (id, type, content, status, confidence, user_verified, valid_from, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'accepted', ?4, 1, ?5, ?5, ?5)",
        params![new_id, memory_type, new_content.trim(), old.confidence, now],
    )
    .map_err(MemoryApiError::Db)?;
    // Inherit provenance from the old memory (§52: provenance never lost).
    tx.execute(
        "INSERT OR IGNORE INTO memory_sources (memory_id, note_id, claim_id, excerpt)
         SELECT ?1, note_id, claim_id, excerpt FROM memory_sources WHERE memory_id = ?2",
        params![new_id, old_id],
    )
    .map_err(MemoryApiError::Db)?;
    tx.execute(
        "UPDATE memories SET status = 'superseded', valid_until = ?2, updated_at = ?2 WHERE id = ?1",
        params![old_id, now],
    )
    .map_err(MemoryApiError::Db)?;
    tx.commit().map_err(MemoryApiError::Db)?;
    load_entry(conn, &new_id)?.ok_or_else(|| MemoryApiError::NotFound(new_id))
}

fn transition(
    conn: &Connection,
    id: &str,
    from: &[&str],
    to: &str,
    verified: bool,
) -> Result<MemoryEntry, MemoryApiError> {
    let entry = load_entry(conn, id)?.ok_or_else(|| MemoryApiError::NotFound(id.to_string()))?;
    if !from.contains(&entry.status.as_str()) {
        return Err(MemoryApiError::Invalid(format!(
            "cannot move memory from {} to {to}",
            entry.status
        )));
    }
    let now = now_millis();
    conn.execute(
        "UPDATE memories SET status = ?2, user_verified = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, to, verified as i64, now],
    )
    .map_err(MemoryApiError::Db)?;
    load_entry(conn, id)?.ok_or_else(|| MemoryApiError::NotFound(id.to_string()))
}

/// Stale marking (§55): an accepted memory whose source notes are all gone is
/// STALE/REVIEW — never deleted, sources were its evidence.
pub fn mark_stale_memories(conn: &Connection) -> Result<u64, rusqlite::Error> {
    let n = conn.execute(
        "UPDATE memories SET status = 'stale', updated_at = ?1
         WHERE status = 'accepted'
           AND NOT EXISTS (
               SELECT 1 FROM memory_sources ms
               JOIN notes n2 ON n2.id = ms.note_id
               WHERE ms.memory_id = memories.id
           )",
        params![now_millis()],
    )?;
    Ok(n as u64)
}

/// Disputed: set when an open contradiction involves this memory's claim.
#[allow(dead_code)]
pub fn mark_disputed(conn: &Connection, id: &str) -> Result<(), MemoryApiError> {
    conn.execute(
        "UPDATE memories SET status = 'disputed', updated_at = ?2 WHERE id = ?1 AND status = 'accepted'",
        params![id, now_millis()],
    )
    .map_err(MemoryApiError::Db)?;
    Ok(())
}

// ---------- Contradictions (§54) ----------

/// An open contradiction with both claims and their sources (§54: show both
/// sources; never silently choose one).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ContradictionEntry {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub claim_a: ClaimRef,
    pub claim_b: ClaimRef,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ClaimRef {
    pub id: String,
    pub subject: String,
    pub predicate: String,
    pub object: String,
    pub claim_type: String,
    pub polarity: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Resolution {
    /// Both can coexist (different contexts).
    KeepBoth,
    /// The later statement is current; earlier memory is superseded.
    MarkLaterCurrent,
    /// Not a real conflict; dismiss it.
    Ignore,
}

/// Detect contradictions deterministically (§54): same subject + same claim
/// type + opposite polarity among active claims. Conservative by design —
/// only clear polarity flips count; semantic conflicts need the AI layer.
pub fn detect_contradictions(conn: &Connection) -> Result<u64, rusqlite::Error> {
    let now = now_millis();
    // rowid serves as insertion order (§83: claims carry valid_from/valid_until,
    // not created_at) — enough to order the pair deterministically.
    let mut stmt = conn.prepare(
        "SELECT id, subject, claim_type, polarity, source_note_id, source_offset, rowid
         FROM claims WHERE status = 'active' AND claim_type IN ('DECISION','PREFERENCE','FACT','GOAL')",
    )?;
    let claims: Vec<(String, String, String, i32, Option<String>, Option<i64>, i64)> = stmt
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
            ))
        })?
        .collect::<Result<_, _>>()?;

    // Group by (subject, claim_type).
    let mut groups: HashMap<(String, String), Vec<_>> = HashMap::new();
    for c in &claims {
        groups
            .entry((c.1.to_lowercase(), c.2.clone()))
            .or_default()
            .push(c);
    }

    let mut created = 0u64;
    for ((_, claim_type), group) in &groups {
        let positives: Vec<_> = group.iter().filter(|c| c.3 > 0).collect();
        let negatives: Vec<_> = group.iter().filter(|c| c.3 < 0).collect();
        for pos in &positives {
            for neg in &negatives {
                // Deterministic pair: earlier claim first.
                let (a, b) = if pos.6 <= neg.6 { (pos, neg) } else { (neg, pos) };
                // Skip already-recorded pairs.
                let exists: bool = conn
                    .query_row(
                        "SELECT COUNT(*) FROM contradictions
                         WHERE ((claim_a_id = ?1 AND claim_b_id = ?2) OR (claim_a_id = ?2 AND claim_b_id = ?1))
                           AND status = 'open'",
                        params![a.0, b.0],
                        |r| r.get::<_, i64>(0),
                    )
                    .map(|c| c > 0)?;
                if exists {
                    continue;
                }
                let kind = match claim_type.as_str() {
                    "PREFERENCE" => "preference_conflict",
                    "DECISION" => "decision_conflict",
                    "GOAL" => "goal_conflict",
                    _ => "fact_conflict",
                };
                conn.execute(
                    "INSERT INTO contradictions (id, claim_a_id, claim_b_id, kind, status, created_at)
                     VALUES (?1, ?2, ?3, ?4, 'open', ?5)",
                    params![uuid::Uuid::new_v4().to_string(), a.0, b.0, kind, now],
                )?;
                created += 1;
            }
        }
    }
    Ok(created)
}

fn claim_ref(conn: &Connection, claim_id: &str) -> Result<ClaimRef, rusqlite::Error> {
    conn.query_row(
        "SELECT c.id, c.subject, c.predicate, c.object, c.claim_type, c.polarity, n.path
         FROM claims c LEFT JOIN notes n ON n.id = c.source_note_id
         WHERE c.id = ?1",
        params![claim_id],
        |r| {
            Ok(ClaimRef {
                id: r.get(0)?,
                subject: r.get(1)?,
                predicate: r.get(2)?,
                object: r.get(3)?,
                claim_type: r.get(4)?,
                polarity: r.get(5)?,
                note_path: r.get(6)?,
            })
        },
    )
}

/// `contradiction.list` — open contradictions, both sources attached (§54).
pub fn contradictions_list(conn: &Connection) -> Result<Vec<ContradictionEntry>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, claim_a_id, claim_b_id, kind, status, created_at
         FROM contradictions WHERE status = 'open' ORDER BY created_at",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, i64>(5)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, a, b, kind, created) = row?;
        out.push(ContradictionEntry {
            id,
            kind,
            status: "open".to_string(),
            claim_a: claim_ref(conn, &a)?,
            claim_b: claim_ref(conn, &b)?,
            created_at: created,
        });
    }
    Ok(out)
}

/// `contradiction.resolve` (§20: Keep Both / Mark Later Current / Ignore).
pub fn resolve_contradiction(
    conn: &Connection,
    id: &str,
    resolution: Resolution,
) -> Result<String, MemoryApiError> {
    let now = now_millis();
    let (a_id, b_id): (String, String) = conn
        .query_row(
            "SELECT claim_a_id, claim_b_id FROM contradictions WHERE id = ?1 AND status = 'open'",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(MemoryApiError::Db)?
        .ok_or_else(|| MemoryApiError::NotFound(id.to_string()))?;

    match resolution {
        Resolution::KeepBoth | Resolution::Ignore => {
            let status = match resolution {
                Resolution::KeepBoth => "resolved_keep_both",
                _ => "ignored",
            };
            conn.execute(
                "UPDATE contradictions SET status = ?2, resolved_at = ?3 WHERE id = ?1",
                params![id, status, now],
            )
            .map_err(MemoryApiError::Db)?;
        }
        Resolution::MarkLaterCurrent => {
            // Supersede the earlier claim's memory with the later one's when
            // both exist; otherwise close as keep_both (nothing to supersede).
            let memory_for = |claim_id: &str| -> Result<Option<String>, rusqlite::Error> {
                conn.query_row(
                    "SELECT memory_id FROM memory_sources WHERE claim_id = ?1 LIMIT 1",
                    params![claim_id],
                    |r| r.get(0),
                )
                .optional()
            };
            let mem_a = memory_for(&a_id).map_err(MemoryApiError::Db)?;
            let mem_b = memory_for(&b_id).map_err(MemoryApiError::Db)?;
            if let (Some(old), Some(new)) = (mem_a.clone(), mem_b.clone()) {
                if old != new {
                    // a is earlier by construction; b is current.
                    let old_status: String = conn
                        .query_row("SELECT status FROM memories WHERE id = ?1", params![old], |r| r.get(0))
                        .unwrap_or_default();
                    if old_status == "accepted" || old_status == "candidate" {
                        conn.execute(
                            "UPDATE memories SET status = 'superseded', valid_until = ?2, updated_at = ?2 WHERE id = ?1",
                            params![old, now],
                        )
                        .map_err(MemoryApiError::Db)?;
                        conn.execute(
                            "UPDATE memories SET status = 'accepted', user_verified = 1, updated_at = ?2 WHERE id = ?1 AND status = 'candidate'",
                            params![new, now],
                        )
                        .map_err(MemoryApiError::Db)?;
                    }
                }
            }
            conn.execute(
                "UPDATE contradictions SET status = 'resolved_later_current', resolved_at = ?2 WHERE id = ?1",
                params![id, now],
            )
            .map_err(MemoryApiError::Db)?;
        }
    }
    Ok(match resolution {
        Resolution::KeepBoth => "kept both".to_string(),
        Resolution::MarkLaterCurrent => "later claim marked current".to_string(),
        Resolution::Ignore => "ignored".to_string(),
    })
}

/// API-level errors mapped to protocol errors by the dispatcher.
#[derive(Debug)]
pub enum MemoryApiError {
    NotFound(String),
    Invalid(String),
    Db(rusqlite::Error),
}

impl From<rusqlite::Error> for MemoryApiError {
    fn from(e: rusqlite::Error) -> Self {
        MemoryApiError::Db(e)
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
