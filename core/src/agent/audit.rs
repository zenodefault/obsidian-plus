//! Audit system (PLAN.md §66): hash-chained, append-only event log.
//!
//! Every important operation records actor, reason, target, approval and
//! result, chained by hash so tampering is detectable. Logs never contain
//! note contents (§66, §97) — only ids, paths and outcomes.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// One audit event (§66 shape).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AuditEvent {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    pub actor: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval: Option<String>,
    pub result: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_hash: Option<String>,
    pub new_hash: String,
    pub created_at: i64,
}

/// Append one event to the chain. `new_hash` = SHA-256 over the previous
/// hash plus the event material — any later tampering breaks the chain.
pub fn append(
    conn: &Connection,
    operation_id: Option<&str>,
    actor: &str,
    reason: Option<&str>,
    target: Option<&str>,
    approval: Option<&str>,
    result: &str,
) -> Result<AuditEvent, rusqlite::Error> {
    let previous: Option<String> = conn
        .query_row(
            "SELECT new_hash FROM audit_events ORDER BY rowid DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let now = now_millis();
    let id = uuid::Uuid::new_v4().to_string();
    let material = format!(
        "{}|{}|{}|{}|{}|{}|{}",
        previous.as_deref().unwrap_or(""),
        actor,
        target.unwrap_or(""),
        approval.unwrap_or(""),
        result,
        id,
        now
    );
    let new_hash = crate::vault::manager::hash_content(&material);
    conn.execute(
        "INSERT INTO audit_events (id, operation_id, actor, reason, target, approval, result, previous_hash, new_hash, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![id, operation_id, actor, reason, target, approval, result, previous, new_hash, now],
    )?;
    Ok(AuditEvent {
        id,
        operation_id: operation_id.map(str::to_string),
        actor: actor.to_string(),
        reason: reason.map(str::to_string),
        target: target.map(str::to_string),
        approval: approval.map(str::to_string),
        result: result.to_string(),
        previous_hash: previous,
        new_hash,
        created_at: now,
    })
}

/// Read the audit trail (§60 `audit.read`), newest last.
pub fn list(conn: &Connection, limit: usize) -> Result<Vec<AuditEvent>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, operation_id, actor, reason, target, approval, result, previous_hash, new_hash, created_at
         FROM audit_events ORDER BY rowid DESC LIMIT ?1",
    )?;
    let mut events: Vec<AuditEvent> = stmt
        .query_map(params![limit as i64], |r| {
            Ok(AuditEvent {
                id: r.get(0)?,
                operation_id: r.get(1)?,
                actor: r.get(2)?,
                reason: r.get(3)?,
                target: r.get(4)?,
                approval: r.get(5)?,
                result: r.get(6)?,
                previous_hash: r.get(7)?,
                new_hash: r.get(8)?,
                created_at: r.get(9)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    events.reverse();
    Ok(events)
}

/// Verify the chain: every event's `previous_hash` must match the prior
/// event's `new_hash` and every stored hash must re-derive. Security test
/// target (§99).
pub fn verify_chain(conn: &Connection) -> Result<bool, rusqlite::Error> {
    let events = list(conn, 10_000)?;
    let mut previous: Option<String> = None;
    for e in &events {
        if e.previous_hash != previous {
            return Ok(false);
        }
        let material = format!(
            "{}|{}|{}|{}|{}|{}|{}",
            e.previous_hash.as_deref().unwrap_or(""),
            e.actor,
            e.target.as_deref().unwrap_or(""),
            e.approval.as_deref().unwrap_or(""),
            e.result,
            e.id,
            e.created_at
        );
        if crate::vault::manager::hash_content(&material) != e.new_hash {
            return Ok(false);
        }
        previous = Some(e.new_hash.clone());
    }
    Ok(true)
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
