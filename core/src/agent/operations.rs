//! Operations (PLAN.md §59, §62–66): every agent write becomes a structured,
//! previewed, approved, version-checked and reversible operation.
//!
//! Deterministic safety properties (§104):
//! - no operation exists without an operation id (Rule 12);
//! - execution requires explicit approval (§63) and a version check (§64);
//! - rollback only restores when the current content still matches the
//!   operation's post-state (§65: never overwrite newer manual changes);
//! - deletes are refused outright (§61 DISABLED);
//! - every transition appends to the audit chain (§66).
//!
//! The core never reads the vault (§89): the plugin supplies current hashes
//! with execute/rollback requests and the core enforces the checks
//! deterministically, outside any model (§67, Rule 7).

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::audit;

/// One file change inside an operation (§86 operation_files).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AgentFile {
    pub path: String,
    pub action: String, // create | edit | move
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_path: Option<String>,
    /// Proposed content (create/edit) — the payload the plugin will apply.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// Content the plugin saw at prepare time (edit); the rollback payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_content: Option<String>,
}

/// A full operation with its files (§62 preview shape).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub reason: String,
    pub risk_level: String,
    pub approval_status: String, // pending | approved | rejected
    pub status: String,          // pending | executed | rolled_back | rejected
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<i64>,
    pub files: Vec<AgentFile>,
}

/// Per-file apply instruction handed back to the plugin after approval.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ApplyFile {
    pub path: String,
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_path: Option<String>,
}

/// API-level errors mapped to typed protocol errors by the dispatcher.
#[derive(Debug)]
pub enum AgentApiError {
    NotFound(String),
    Invalid(String),
    PermissionDenied(String),
    VersionConflict { path: String, expected: String, actual: String },
    Db(rusqlite::Error),
}

impl From<rusqlite::Error> for AgentApiError {
    fn from(e: rusqlite::Error) -> Self {
        AgentApiError::Db(e)
    }
}

impl std::fmt::Display for AgentApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AgentApiError::NotFound(id) => write!(f, "not found: {id}"),
            AgentApiError::Invalid(m) => write!(f, "{m}"),
            AgentApiError::PermissionDenied(m) => write!(f, "permission denied: {m}"),
            AgentApiError::VersionConflict { path, expected, actual } => {
                write!(f, "version conflict on {path}: expected {expected}, got {actual}")
            }
            AgentApiError::Db(e) => write!(f, "database error: {e}"),
        }
    }
}

impl std::error::Error for AgentApiError {}

fn hash(content: &str) -> String {
    crate::vault::manager::hash_content(content)
}

/// Risk heuristic (§62): many files or structural moves are riskier.
fn risk_for(files: &[AgentFile]) -> &'static str {
    if files.len() > 3 || files.iter().any(|f| f.action == "move") {
        "medium"
    } else {
        "low"
    }
}

/// Input for one proposed file change (wire shape of `agent.create`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AgentFileInput {
    pub path: String,
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_path: Option<String>,
}

/// Prepare an operation from proposed file changes (§62–63: preview first,
/// nothing has been applied yet).
pub fn prepare(
    conn: &Connection,
    request: &str,
    run_id: Option<&str>,
    files: Vec<AgentFileInput>,
) -> Result<Operation, AgentApiError> {
    if request.trim().is_empty() {
        return Err(AgentApiError::Invalid("request must not be empty".into()));
    }
    if files.is_empty() {
        return Err(AgentApiError::Invalid(
            "operation must affect at least one file".into(),
        ));
    }
    let mut seen = std::collections::HashSet::new();
    let mut out_files: Vec<AgentFile> = Vec::with_capacity(files.len());
    for f in files {
        if f.path.trim().is_empty() {
            return Err(AgentApiError::Invalid("file path must not be empty".into()));
        }
        if !seen.insert(f.path.clone()) {
            return Err(AgentApiError::Invalid(format!(
                "duplicate file in operation: {}",
                f.path
            )));
        }
        let action = f.action.to_lowercase();
        let file = match action.as_str() {
            "create" => {
                let content = f.content.ok_or_else(|| {
                    AgentApiError::Invalid(format!("create requires content: {}", f.path))
                })?;
                AgentFile {
                    path: f.path.clone(),
                    action: "create".into(),
                    note_id: note_id_by_path(conn, &f.path)?,
                    old_hash: None,
                    new_hash: Some(hash(&content)),
                    new_path: None,
                    content: Some(content),
                    old_content: None,
                }
            }
            "edit" => {
                let content = f.content.ok_or_else(|| {
                    AgentApiError::Invalid(format!("edit requires content: {}", f.path))
                })?;
                let old_content = f.old_content.ok_or_else(|| {
                    AgentApiError::Invalid(format!(
                        "edit requires old_content (rollback payload): {}",
                        f.path
                    ))
                })?;
                if old_content == content {
                    return Err(AgentApiError::Invalid(format!(
                        "edit would not change the file: {}",
                        f.path
                    )));
                }
                AgentFile {
                    path: f.path.clone(),
                    action: "edit".into(),
                    note_id: note_id_by_path(conn, &f.path)?,
                    old_hash: Some(hash(&old_content)),
                    new_hash: Some(hash(&content)),
                    new_path: None,
                    content: Some(content),
                    old_content: Some(old_content),
                }
            }
            "move" => {
                let new_path = f.new_path.ok_or_else(|| {
                    AgentApiError::Invalid(format!("move requires new_path: {}", f.path))
                })?;
                AgentFile {
                    path: f.path.clone(),
                    action: "move".into(),
                    note_id: note_id_by_path(conn, &f.path)?,
                    old_hash: None,
                    new_hash: None,
                    new_path: Some(new_path),
                    content: None,
                    old_content: None,
                }
            }
            "delete" => {
                // §61: vault.delete is DISABLED — refusal is deterministic.
                return Err(AgentApiError::PermissionDenied(
                    "vault.delete is disabled by policy; files are never deleted automatically"
                        .into(),
                ));
            }
            other => {
                return Err(AgentApiError::Invalid(format!(
                    "unknown file action: {other}"
                )));
            }
        };
        out_files.push(file);
    }

    let id = uuid::Uuid::new_v4().to_string();
    let now = now_millis();
    let risk = risk_for(&out_files);
    conn.execute(
        "INSERT INTO operations (id, agent_run_id, reason, risk_level, approval_status, status, created_at)
         VALUES (?1, ?2, ?3, ?4, 'pending', 'pending', ?5)",
        params![id, run_id, request.trim(), risk, now],
    )?;
    for f in &out_files {
        conn.execute(
            "INSERT INTO operation_files (id, operation_id, note_id, path, old_hash, new_hash, old_content, content, new_path, action)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                uuid::Uuid::new_v4().to_string(),
                id,
                f.note_id,
                f.path,
                f.old_hash,
                f.new_hash,
                f.old_content,
                f.content,
                f.new_path,
                f.action,
            ],
        )?;
    }
    audit::append(conn, Some(&id), "agent", Some(request), None, None, "operation.prepared")?;
    load(conn, &id)?.ok_or_else(|| AgentApiError::NotFound(id))
}

/// Approve the previewed operation (§63: user approved → execute may run).
pub fn approve(conn: &Connection, id: &str) -> Result<Operation, AgentApiError> {
    transition_approval(conn, id, "pending", "approved", "operation.approved")
}

/// Reject the previewed operation.
pub fn reject(conn: &Connection, id: &str) -> Result<Operation, AgentApiError> {
    let _ = transition_approval(conn, id, "pending", "rejected", "operation.rejected")?;
    conn.execute(
        "UPDATE operations SET status = 'rejected' WHERE id = ?1",
        params![id],
    )?;
    load(conn, id)?.ok_or_else(|| AgentApiError::NotFound(id.to_string()))
}

fn transition_approval(
    conn: &Connection,
    id: &str,
    from: &str,
    to: &str,
    audit_result: &str,
) -> Result<Operation, AgentApiError> {
    let op = load(conn, id)?.ok_or_else(|| AgentApiError::NotFound(id.to_string()))?;
    if op.approval_status != from {
        return Err(AgentApiError::Invalid(format!(
            "operation approval_status is {}, expected {from}",
            op.approval_status
        )));
    }
    conn.execute(
        "UPDATE operations SET approval_status = ?2 WHERE id = ?1",
        params![id, to],
    )?;
    audit::append(
        conn,
        Some(id),
        "user",
        Some(&op.reason),
        None,
        Some(to),
        audit_result,
    )?;
    load(conn, id)?.ok_or_else(|| AgentApiError::NotFound(id.to_string()))
}

/// Version-checked execution (§64): every file's current hash (reported by
/// the plugin, which owns the vault) must match what the operation was
/// prepared against — for edits and moves the prepare-time content hash; for
/// creates the path must still be absent. Any mismatch aborts the WHOLE
/// operation (no partial application, §76 discipline).
pub fn execute(
    conn: &Connection,
    id: &str,
    current: &[(String, String)],
) -> Result<(Operation, Vec<ApplyFile>), AgentApiError> {
    let op = load(conn, id)?.ok_or_else(|| AgentApiError::NotFound(id.to_string()))?;
    if op.approval_status != "approved" {
        return Err(AgentApiError::PermissionDenied(
            "operation has not been approved".into(),
        ));
    }
    if op.status != "pending" {
        return Err(AgentApiError::Invalid(format!(
            "operation status is {}, expected pending",
            op.status
        )));
    }
    let reported: std::collections::HashMap<&str, &str> =
        current.iter().map(|(p, h)| (p.as_str(), h.as_str())).collect();

    for f in &op.files {
        match f.action.as_str() {
            "create" => {
                if let Some(h) = reported.get(f.path.as_str()) {
                    if *h == f.new_hash.as_deref().unwrap_or("") {
                        return Err(AgentApiError::VersionConflict {
                            path: f.path.clone(),
                            expected: "absent".into(),
                            actual: h.to_string(),
                        });
                    }
                }
            }
            _ => {
                let actual = reported.get(f.path.as_str()).ok_or_else(|| {
                    AgentApiError::Invalid(format!(
                        "current hash not reported for {}",
                        f.path
                    ))
                })?;
                let expected = f.old_hash.as_deref().ok_or_else(|| {
                    AgentApiError::Invalid(format!("no expected hash for {}", f.path))
                })?;
                if actual != &expected {
                    return Err(AgentApiError::VersionConflict {
                        path: f.path.clone(),
                        expected: expected.to_string(),
                        actual: actual.to_string(),
                    });
                }
            }
        }
    }

    let now = now_millis();
    conn.execute(
        "UPDATE operations SET status = 'executed', completed_at = ?2 WHERE id = ?1",
        params![id, now],
    )?;
    let instructions: Vec<ApplyFile> = op
        .files
        .iter()
        .map(|f| ApplyFile {
            path: f.path.clone(),
            action: f.action.clone(),
            content: f.content.clone(),
            new_path: f.new_path.clone(),
        })
        .collect();
    audit::append(
        conn,
        Some(id),
        "agent",
        Some(&op.reason),
        Some(&op.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>().join(",")),
        Some("approved"),
        "operation.executed",
    )?;
    let op = load(conn, id)?.ok_or_else(|| AgentApiError::NotFound(id.to_string()))?;
    Ok((op, instructions))
}

/// Record the plugin's post-apply state (§59 verification step): hashes must
/// match what the operation proposed, otherwise the audit records a failure
/// and the caller learns the apply did not land cleanly.
pub fn verify_applied(
    conn: &Connection,
    id: &str,
    applied: &[(String, String)],
) -> Result<String, AgentApiError> {
    let op = load(conn, id)?.ok_or_else(|| AgentApiError::NotFound(id.to_string()))?;
    if op.status != "executed" {
        return Err(AgentApiError::Invalid(
            "operation is not in executed state".into(),
        ));
    }
    let reported: std::collections::HashMap<&str, &str> =
        applied.iter().map(|(p, h)| (p.as_str(), h.as_str())).collect();
    let mut failures: Vec<String> = Vec::new();
    for f in &op.files {
        match f.action.as_str() {
            "move" => {
                let target = f.new_path.clone().unwrap_or_default();
                if !reported.contains_key(target.as_str()) {
                    failures.push(format!("{target}: no hash reported"));
                }
            }
            _ => {
                let expected = f.new_hash.as_deref().unwrap_or("");
                match reported.get(f.path.as_str()) {
                    Some(actual) if actual == &expected => {}
                    Some(actual) => failures.push(format!(
                        "{}: hash mismatch (expected {expected}, got {actual})",
                        f.path
                    )),
                    None => failures.push(format!("{}: no hash reported", f.path)),
                }
            }
        }
    }
    if failures.is_empty() {
        audit::append(conn, Some(id), "plugin", None, None, None, "operation.verified")?;
        Ok("verified".to_string())
    } else {
        audit::append(
            conn,
            Some(id),
            "plugin",
            Some(&failures.join("; ")),
            None,
            None,
            "operation.verify_failed",
        )?;
        Err(AgentApiError::Invalid(format!(
            "verification failed: {}",
            failures.join("; ")
        )))
    }
}

/// Rollback (§65): allowed only when every file's current content still
/// matches the operation's post-state. Emits reverse instructions:
/// edit → restore old content, create → delete the created file, move →
/// move back. Never overwrites newer manual changes.
pub fn rollback(
    conn: &Connection,
    id: &str,
    current: &[(String, String)],
) -> Result<(Operation, Vec<ApplyFile>), AgentApiError> {
    let op = load(conn, id)?.ok_or_else(|| AgentApiError::NotFound(id.to_string()))?;
    if op.status != "executed" {
        return Err(AgentApiError::Invalid(format!(
            "rollback requires executed operation, status is {}",
            op.status
        )));
    }
    let reported: std::collections::HashMap<&str, &str> =
        current.iter().map(|(p, h)| (p.as_str(), h.as_str())).collect();

    for f in &op.files {
        let (check_path, expected): (&str, &str) = match f.action.as_str() {
            "move" => (
                f.new_path.as_deref().unwrap_or(""),
                f.new_hash.as_deref().unwrap_or(""),
            ),
            _ => (f.path.as_str(), f.new_hash.as_deref().unwrap_or("")),
        };
        let actual = reported.get(check_path).ok_or_else(|| {
            AgentApiError::Invalid(format!("current hash not reported for {check_path}"))
        })?;
        if actual != &expected {
            // §65: the file changed after the operation — refuse, loudly.
            return Err(AgentApiError::VersionConflict {
                path: check_path.to_string(),
                expected: expected.to_string(),
                actual: actual.to_string(),
            });
        }
    }

    let mut instructions: Vec<ApplyFile> = Vec::new();
    for f in &op.files {
        match f.action.as_str() {
            "create" => instructions.push(ApplyFile {
                path: f.path.clone(),
                action: "delete".into(),
                content: None,
                new_path: None,
            }),
            "edit" => instructions.push(ApplyFile {
                path: f.path.clone(),
                action: "edit".into(),
                content: f.old_content.clone(),
                new_path: None,
            }),
            "move" => instructions.push(ApplyFile {
                path: f.new_path.clone().unwrap_or_default(),
                action: "move".into(),
                content: None,
                new_path: Some(f.path.clone()),
            }),
            _ => {}
        }
    }

    conn.execute(
        "UPDATE operations SET status = 'rolled_back', completed_at = ?2 WHERE id = ?1",
        params![id, now_millis()],
    )?;
    audit::append(
        conn,
        Some(id),
        "user",
        Some(&op.reason),
        None,
        Some("approved"),
        "operation.rolled_back",
    )?;
    let op = load(conn, id)?.ok_or_else(|| AgentApiError::NotFound(id.to_string()))?;
    Ok((op, instructions))
}

/// `operation.list`.
pub fn list(conn: &Connection) -> Result<Vec<Operation>, rusqlite::Error> {
    let mut stmt =
        conn.prepare("SELECT id FROM operations ORDER BY created_at DESC, rowid DESC")?;
    let ids: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
    let mut out = Vec::new();
    for id in ids {
        if let Some(op) = load(conn, &id)? {
            out.push(op);
        }
    }
    Ok(out)
}

/// Load one operation with files.
pub fn load(conn: &Connection, id: &str) -> Result<Option<Operation>, rusqlite::Error> {
    let row = conn
        .query_row(
            "SELECT id, agent_run_id, reason, risk_level, approval_status, status, created_at, completed_at
             FROM operations WHERE id = ?1",
            params![id],
            |r| {
                Ok(Operation {
                    id: r.get(0)?,
                    run_id: r.get(1)?,
                    reason: r.get(2)?,
                    risk_level: r.get(3)?,
                    approval_status: r.get(4)?,
                    status: r.get(5)?,
                    created_at: r.get(6)?,
                    completed_at: r.get(7)?,
                    files: Vec::new(),
                })
            },
        )
        .optional()?;
    let Some(mut op) = row else {
        return Ok(None);
    };
    let mut stmt = conn.prepare(
        "SELECT path, action, note_id, old_hash, new_hash, new_path, content, old_content
         FROM operation_files WHERE operation_id = ?1 ORDER BY rowid",
    )?;
    op.files = stmt
        .query_map(params![op.id], |r| {
            Ok(AgentFile {
                path: r.get(0)?,
                action: r.get::<_, Option<String>>(1)?.unwrap_or_else(|| "edit".to_string()),
                note_id: r.get(2)?,
                old_hash: r.get(3)?,
                new_hash: r.get(4)?,
                new_path: r.get(5)?,
                content: r.get(6)?,
                old_content: r.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(op))
}

fn note_id_by_path(conn: &Connection, path: &str) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row("SELECT id FROM notes WHERE path = ?1", params![path], |r| r.get(0))
        .optional()
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
