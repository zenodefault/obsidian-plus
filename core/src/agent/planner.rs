//! Deterministic agent planner (PLAN.md §59, §114 Workstream 7).
//!
//! Turns an approved user request into a *proposed* operation — no LLM in the
//! planning loop (§7: deterministic code wherever possible; the local model
//! may refine proposals in a later workstream, never the safety path). The
//! planner only ever proposes: nothing executes without preview + approval
//! (§59 pipeline).

use super::operations::{AgentApiError, AgentFileInput};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// What the planner understood from the request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Plan {
    pub goal: String,
    pub files: Vec<AgentFileInput>,
    /// Why these files were chosen (shown in the preview's WHY block, §63).
    pub rationale: Vec<String>,
}

/// Wire shape of `agent.plan`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, default)]
pub struct PlanParams {
    pub request: String,
    /// A "link" suggestion target: link every listed path to this note.
    pub link_target: Option<String>,
    /// Paths to consolidate into `target`.
    pub merge_paths: Option<Vec<String>>,
    pub merge_target: Option<String>,
}

/// Plan a proposed operation. Strategies, in precedence order:
/// 1. merge — fold duplicate notes into a target note (§70 consolidation);
/// 2. link — add `[[target]]` references to the listed notes (§70 suggested links);
/// 3. metadata — add a title heading to untitled notes (§70 properties).
/// Everything else is refused: the planner never invents write intents it
/// cannot ground in vault state.
pub fn plan(conn: &Connection, params: &PlanParams) -> Result<Plan, AgentApiError> {
    if params.request.trim().is_empty() {
        return Err(AgentApiError::Invalid("request must not be empty".into()));
    }
    if let (Some(target), Some(paths)) = (&params.merge_target, &params.merge_paths) {
        return plan_merge(conn, &params.request, target, paths);
    }
    if let Some(target) = &params.link_target {
        return plan_link(conn, &params.request, target);
    }
    plan_metadata(conn, &params.request)
}

/// Merge: append each source note's content under a section in the target.
/// Sources are NOT deleted (§61: delete is disabled; §104 Rule 9) — the
/// preview leaves them in place for the user to clean up manually.
fn plan_merge(
    conn: &Connection,
    request: &str,
    target: &str,
    paths: &[String],
) -> Result<Plan, AgentApiError> {
    let target_row = note_by_path(conn, target)?
        .ok_or_else(|| AgentApiError::Invalid(format!("merge target not found: {target}")))?;
    let sources: Vec<String> = paths
        .iter()
        .filter(|p| p.as_str() != target)
        .cloned()
        .collect();
    if sources.is_empty() {
        return Err(AgentApiError::Invalid(
            "merge needs at least one source besides the target".into(),
        ));
    }
    let mut body = String::new();
    let mut rationale = Vec::new();
    for src in &sources {
        let content = note_excerpt(conn, src)?.ok_or_else(|| {
            AgentApiError::Invalid(format!("merge source not found: {src}"))
        })?;
        let title = src.trim_end_matches(".md").rsplit('/').next().unwrap_or(src);
        body.push_str(&format!("\n\n## From {}\n\n{}", title, content.trim()));
        rationale.push(format!("fold {src} into {target} (source kept, not deleted)"));
    }
    let new_content = format!("{}\n{}", target_row.content.trim_end(), body);
    Ok(Plan {
        goal: request.to_string(),
        files: vec![AgentFileInput {
            path: target.to_string(),
            action: "edit".into(),
            content: Some(new_content),
            old_content: Some(target_row.content),
            new_path: None,
        }],
        rationale,
    })
}

/// Link: add a `[[target]]` reference line to each listed note.
fn plan_link(
    conn: &Connection,
    request: &str,
    target: &str,
) -> Result<Plan, AgentApiError> {
    let candidates: Vec<String> = linked_candidates(conn, target)?;
    if candidates.is_empty() {
        return Err(AgentApiError::Invalid(format!(
            "no indexed notes mention {}; nothing to link",
            target
        )));
    }
    let stem = target.trim_end_matches(".md");
    let link_name = stem.rsplit('/').next().unwrap_or(stem);
    let link_line = format!("Related: [[{link_name}]]");
    let mut files = Vec::new();
    let mut rationale = Vec::new();
    for path in &candidates {
        let content = note_excerpt(conn, path)?.ok_or_else(|| {
            AgentApiError::Invalid(format!("note not found: {path}"))
        })?;
        if content.contains(&format!("[[{link_name}]]")) {
            continue; // already linked — idempotent planning
        }
        let new_content = format!("{}\n\n{}", content.trim_end(), link_line);
        files.push(AgentFileInput {
            path: path.clone(),
            action: "edit".into(),
            content: Some(new_content),
            old_content: Some(content),
            new_path: None,
        });
        rationale.push(format!("add [[{link_name}]] link to {path}"));
    }
    if files.is_empty() {
        return Err(AgentApiError::Invalid(
            "all candidate notes already link to the target".into(),
        ));
    }
    Ok(Plan {
        goal: request.to_string(),
        files,
        rationale,
    })
}

/// Metadata: give untitled/heading-less notes a title heading (§70
/// properties). Conservative: only notes with no H1 at all.
fn plan_metadata(conn: &Connection, request: &str) -> Result<Plan, AgentApiError> {
    let conn_rows: Vec<(String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT path, IFNULL(title, '') FROM notes WHERE status = 'active' ORDER BY path LIMIT 100",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let mut files = Vec::new();
    let mut rationale = Vec::new();
    for (path, title) in conn_rows {
        if title.is_empty() {
            continue;
        }
        let Some(content) = note_excerpt(conn, &path)? else {
            continue;
        };
        if content.lines().any(|l| l.trim_start().starts_with("# ")) {
            continue;
        }
        let new_content = format!("# {}\n\n{}", title, content.trim_start());
        files.push(AgentFileInput {
            path: path.clone(),
            action: "edit".into(),
            content: Some(new_content),
            old_content: Some(content),
            new_path: None,
        });
        rationale.push(format!("add missing title heading to {path}"));
        if files.len() >= 5 {
            break; // bounded plans (§91, §92)
        }
    }
    if files.is_empty() {
        return Err(AgentApiError::Invalid(
            "no organization opportunities found; the vault looks tidy".into(),
        ));
    }
    Ok(Plan {
        goal: request.to_string(),
        files,
        rationale,
    })
}

/// Notes that mention the target (wikilink target, title or path stem) —
/// the §70 "suggested links" candidate set, deterministic.
fn linked_candidates(conn: &Connection, target: &str) -> Result<Vec<String>, rusqlite::Error> {
    let stem = target.trim_end_matches(".md");
    let base = stem.rsplit('/').next().unwrap_or(stem).to_lowercase();
    let mut stmt = conn.prepare(
        "SELECT DISTINCT n.path FROM notes n
         LEFT JOIN note_links nl ON nl.note_id = n.id AND nl.target = ?1
         WHERE n.status = 'active'
           AND n.path != ?2
           AND (nl.target IS NULL OR 1 = 1)
         LIMIT 200",
    )?;
    let all: Vec<String> = stmt
        .query_map(rusqlite::params![stem, target], |r| r.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut out = Vec::new();
    for path in all {
        let Some(content) = note_excerpt(conn, &path)? else {
            continue;
        };
        let lower = content.to_lowercase();
        if lower.contains(&base) {
            out.push(path);
        }
        if out.len() >= 5 {
            break;
        }
    }
    Ok(out)
}

struct NoteRow {
    content: String,
}

impl NoteRow {
    // Placeholder to keep the struct meaningful if expanded later.
}

fn note_by_path(conn: &Connection, path: &str) -> Result<Option<NoteRow>, rusqlite::Error> {
    // Content is not stored by the core (§89); the "content" for planning is
    // reconstructed from chunk text, which is what the core genuinely knows.
    let chunks: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT c.text FROM chunks c JOIN notes n ON n.id = c.note_id
             WHERE n.path = ?1 AND n.status = 'active' ORDER BY c.ordinal",
        )?;
        let rows = stmt.query_map(rusqlite::params![path], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    if chunks.is_empty() {
        return Ok(None);
    }
    Ok(Some(NoteRow {
        content: chunks.join("\n\n"),
    }))
}

fn note_excerpt(conn: &Connection, path: &str) -> Result<Option<String>, rusqlite::Error> {
    Ok(note_by_path(conn, path)?.map(|n| n.content))
}
