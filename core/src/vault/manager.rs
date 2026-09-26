//! Sync engine: session lifecycle, inventory diff, rename detection, identity.
//!
//! The plugin owns the vault (§4.1, §89); this manager only maintains derived
//! state, now persisted in SQLite via `NoteIndex` (Part 3). All classification
//! is deterministic and unit-testable (§7).

use crate::indexing::NoteIndex;
use crate::protocol::{ErrorCode, RpcError};
use crate::vault::types::{
    RenamePair, StateGetResult, StateNoteEntry, SyncBatchParams, SyncBeginResult, SyncCommitResult,
    SyncFinishResult, SyncNote, SyncNoteResult,
};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

/// One inventory entry recorded during a sync session.
#[derive(Debug, Clone, PartialEq)]
struct InventoryEntry {
    hash: String,
    mtime: i64,
    size: i64,
}

/// Content the session still needs, decided at commit time.
#[derive(Debug, Default)]
struct PendingPlan {
    to_fetch: Vec<String>,
}

/// An in-flight sync session.
#[derive(Debug)]
struct Session {
    session_id: String,
    inventory: HashMap<String, InventoryEntry>,
    pending: Option<PendingPlan>,
}

/// Owns sync state (SQLite) and active sessions. Shared behind `Arc`.
pub struct SyncManager {
    index: NoteIndex,
    session: Mutex<Option<Session>>,
}

impl SyncManager {
    pub fn new(data_dir: &Path) -> Arc<Self> {
        let index = match NoteIndex::open(data_dir) {
            Ok(i) => i,
            Err(e) => {
                crate::utils::logging::log(
                    crate::utils::logging::Level::Error,
                    "sync",
                    "failed to open database",
                    serde_json::json!({ "error": e.to_string() }),
                );
                panic!("database unavailable: {e}");
            }
        };
        Arc::new(Self {
            index,
            session: Mutex::new(None),
        })
    }

    /// Number of notes currently known (for tests and health surfaces).
    pub fn total_notes(&self) -> u64 {
        self.index.total_notes().unwrap_or(0) as u64
    }

    /// Shared connection access (memory/health operations in tests and tools).
    pub fn index_connection(&self) -> &rusqlite::Connection {
        self.index.connection()
    }

    /// `vault.sync.begin` — open a session, honouring rebuild.
    ///
    /// A still-active previous session is abandoned (not rolled back): with a
    /// single plugin client, a new `begin` proves the old session is garbage
    /// after a crash or failure.
    pub fn begin(&self, rebuild: bool) -> Result<SyncBeginResult, RpcError> {
        let mut session = self.lock_session();
        if let Some(old) = session.take() {
            crate::utils::logging::log(
                crate::utils::logging::Level::Warn,
                "sync",
                "abandoning previous sync session",
                serde_json::json!({ "session_id": old.session_id }),
            );
        }
        if rebuild {
            self.reset_state();
        }
        let session_id = Uuid::new_v4().to_string();
        *session = Some(Session {
            session_id: session_id.clone(),
            inventory: HashMap::new(),
            pending: None,
        });
        Ok(SyncBeginResult {
            session_id,
            rebuild,
        })
    }

    /// `vault.sync.batch` — record one chunk of the inventory.
    pub fn batch(&self, params: &SyncBatchParams) -> Result<u64, RpcError> {
        let mut session = self.lock_session();
        let Some(s) = session.as_mut() else {
            return Err(no_session());
        };
        if s.session_id != params.session_id {
            return Err(session_mismatch());
        }
        for note in &params.notes {
            s.inventory.insert(
                note.path.clone(),
                InventoryEntry {
                    hash: note.hash.clone(),
                    mtime: note.mtime as i64,
                    size: note.size as i64,
                },
            );
        }
        Ok(params.notes.len() as u64)
    }

    /// `vault.sync.commit` — diff inventory vs SQLite state, detect renames,
    /// apply deletions, and return the paths whose content is needed.
    pub fn commit(&self, session_id: &str) -> Result<SyncCommitResult, RpcError> {
        let mut session = self.lock_session();
        let Some(s) = session.as_mut() else {
            return Err(no_session());
        };
        if s.session_id != session_id {
            return Err(session_mismatch());
        }

        // Current state from SQLite: path → sha256.
        let state: HashMap<String, String> = {
            let conn = self.index.connection();
            let mut stmt = conn
                .prepare("SELECT path, sha256 FROM notes")
                .map_err(db_err)?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(db_err)?;
            rows.collect::<Result<HashMap<_, _>, _>>().map_err(db_err)?
        };

        let inventory_paths: HashSet<&String> = s.inventory.keys().collect();

        // First pass: classify.
        let mut added: Vec<String> = Vec::new();
        let mut modified: Vec<String> = Vec::new();
        let mut deleted: Vec<String> = Vec::new();

        for path in s.inventory.keys() {
            match state.get(path) {
                None => added.push(path.clone()),
                Some(existing_hash) => {
                    if *existing_hash != s.inventory[path].hash {
                        modified.push(path.clone());
                    }
                }
            }
        }
        for path in state.keys() {
            if !inventory_paths.contains(path) {
                deleted.push(path.clone());
            }
        }
        added.sort();
        modified.sort();
        deleted.sort();

        // Rename detection (§39): an added path whose hash matches exactly one
        // deleted path inherits that note's identity. Deterministic pairing:
        // both sides sorted; first match wins.
        let mut renames: Vec<RenamePair> = Vec::new();
        let mut consumed_deleted: HashSet<String> = HashSet::new();
        let mut rename_targets: HashSet<String> = HashSet::new();

        for new_path in &added {
            let Some(entry) = s.inventory.get(new_path) else {
                continue;
            };
            let candidates: Vec<&String> = deleted
                .iter()
                .filter(|old| {
                    !consumed_deleted.contains(*old) && state.get(*old).is_some_and(|h| *h == entry.hash)
                })
                .collect();
            if candidates.len() == 1 {
                let old = (*candidates[0]).clone();
                consumed_deleted.insert(old.clone());
                rename_targets.insert(new_path.clone());
                renames.push(RenamePair {
                    from: old,
                    to: new_path.clone(),
                });
            }
        }

        // Apply renames in SQLite: path moves, id (and chunks) carry over.
        for pair in &renames {
            self.index
                .rename_note(&pair.from, &pair.to)
                .map_err(db_err)?;
        }

        // Apply true deletions (paths not matched as renames).
        for path in &deleted {
            if !consumed_deleted.contains(path) {
                self.index.delete_note(path).map_err(db_err)?;
            }
        }

        let applied = (renames.len()
            + deleted.iter().filter(|p| !consumed_deleted.contains(*p)).count())
            as u64;
        let to_fetch: Vec<String> = added
            .iter()
            .filter(|p| !rename_targets.contains(*p))
            .chain(modified.iter())
            .cloned()
            .collect();

        s.pending = Some(PendingPlan {
            to_fetch: to_fetch.clone(),
        });

        // Link revalidation: renames and additions may heal broken links.
        let _ = crate::knowledge::revalidate_links(self.index.connection());

        Ok(SyncCommitResult {
            added: added.into_iter().filter(|p| !rename_targets.contains(p)).collect(),
            modified,
            renamed: renames,
            deleted: deleted.into_iter().filter(|p| !consumed_deleted.contains(p)).collect(),
            to_fetch,
            applied,
        })
    }

    /// `vault.sync.note` — receive full content; parse, chunk, index in
    /// SQLite, and enqueue follow-up background work (§77).
    pub fn note(&self, params: &SyncNoteParams<'_>) -> Result<SyncNoteResult, RpcError> {
        let mut session = self.lock_session();
        let Some(s) = session.as_mut() else {
            return Err(no_session());
        };
        if s.session_id != params.session_id {
            return Err(session_mismatch());
        }
        if !s
            .pending
            .as_ref()
            .is_some_and(|p| p.to_fetch.contains(&params.note.path))
        {
            return Err(RpcError::new(
                ErrorCode::InvalidParams,
                format!("path was not requested at commit: {}", params.note.path),
            ));
        }

        let note = &params.note;
        let Some(content) = &note.content else {
            return Err(RpcError::new(
                ErrorCode::InvalidParams,
                "content is required",
            ));
        };

        // Content integrity: the core trusts only what it can verify.
        let actual = crate::vault::manager::hash_content(content);
        if actual != note.hash {
            return Err(RpcError::new(
                ErrorCode::InvalidParams,
                format!("content hash mismatch for {}", note.path),
            )
            .with_details(serde_json::json!({
                "path": note.path,
                "expected": note.hash,
                "actual": actual,
            })));
        }

        let updated = self.index.note_id_by_path(&note.path).map_err(db_err)?.is_some();
        let note_id = self
            .index
            .upsert_note(&note.path, content, note.mtime as i64, note.size as i64)
            .map_err(db_err)?;

        if let Some(pending) = s.pending.as_mut() {
            pending.to_fetch.retain(|p| p != &note.path);
        }

        Ok(SyncNoteResult {
            path: note.path.clone(),
            note_id,
            updated,
        })
    }

    /// `vault.sync.finish` — validate completeness. SQLite writes are already
    /// committed incrementally, so "persisted" is always true here.
    pub fn finish(&self, session_id: &str) -> Result<SyncFinishResult, RpcError> {
        {
            let mut session = self.lock_session();
            let Some(s) = session.as_mut() else {
                return Err(no_session());
            };
            if s.session_id != session_id {
                return Err(session_mismatch());
            }
            if let Some(pending) = &s.pending {
                if !pending.to_fetch.is_empty() {
                    return Err(RpcError::new(
                        ErrorCode::InvalidParams,
                        format!(
                            "{} requested note(s) were not uploaded",
                            pending.to_fetch.len()
                        ),
                    )
                    .with_details(serde_json::json!({ "missing": pending.to_fetch })));
                }
            }
            *session = None;
        }
        // Contradiction detection runs at finish (§54): all claims are in.
        if let Err(e) = crate::memory::detect_contradictions(self.index.connection()) {
            crate::utils::logging::log(
                crate::utils::logging::Level::Warn,
                "sync",
                "contradiction detection failed",
                serde_json::json!({ "error": e.to_string() }),
            );
        }

        Ok(SyncFinishResult {
            total_notes: self.total_notes(),
            persisted: true,
        })
    }

    /// `vault.state.get`.
    pub fn state_get(&self, include_metadata: bool) -> StateGetResult {
        let conn = self.index.connection();
        let mut notes: Vec<StateNoteEntry> = Vec::new();
        if let Ok(mut stmt) =
            conn.prepare("SELECT id, path, title FROM notes WHERE status = 'active' ORDER BY path")
        {
            if let Ok(rows) = stmt.query_map([], |r| {
                Ok(StateNoteEntry {
                    note_id: r.get(0)?,
                    path: r.get(1)?,
                    content_hash: String::new(),
                    title: r.get(2)?,
                    tags: Vec::new(),
                })
            }) {
                for row in rows.flatten() {
                    notes.push(row);
                }
            }
        }
        if include_metadata {
            // Tag extraction joins arrive with the knowledge layer (Part 4);
            // state.get stays lean here (§93: load only what is asked for).
        }
        let total = notes.len() as u64;
        StateGetResult {
            total_notes: total,
            notes,
        }
    }

    /// `vault.rebuild` — wipe derived state; vault is untouched (§9, §90).
    pub fn rebuild(&self) -> bool {
        self.reset_state();
        true
    }

    fn reset_state(&self) {
        let conn = self.index.connection();
        let _ = conn.execute("DELETE FROM notes", []);
        let _ = conn.execute("DELETE FROM jobs WHERE status IN ('pending','running')", []);
    }

    fn lock_session(&self) -> std::sync::MutexGuard<'_, Option<Session>> {
        self.session.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// Borrowed view passed to `SyncManager::note` (avoids cloning content).
pub struct SyncNoteParams<'a> {
    pub session_id: &'a str,
    pub note: &'a SyncNote,
}

impl SyncManager {
    /// `search.query` — FTS5 keyword search (fast path, §94).
    pub fn search(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<crate::indexing::SearchHit>, RpcError> {
        self.index.search(query, limit).map_err(db_err)
    }

    /// `health.summary` — read-only scan of derived state (§68).
    pub fn health_summary(&self) -> Result<crate::health::HealthSummary, RpcError> {
        crate::health::summary(self.index.connection()).map_err(db_err)
    }

    /// `search.query` hybrid arm (§42, §44): lexical + semantic + entity
    /// ranking, deterministic. Falls back to pure lexical when no provider is
    /// available (§76: model failure never breaks search).
    pub fn search_hybrid(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<crate::retrieval::HybridHit>, RpcError> {
        let provider = match crate::models::select_provider(&crate::models::ModelSettings::load(
            self.index.connection(),
        )) {
            Ok(p) => p,
            Err(e) => {
                crate::utils::logging::log(
                    crate::utils::logging::Level::Warn,
                    "search",
                    "model unavailable; falling back to lexical search",
                    serde_json::json!({ "error": e.to_string() }),
                );
                let hits = self.index.search(query, limit).map_err(db_err)?;
                return Ok(hits
                    .into_iter()
                    .map(|h| crate::retrieval::HybridHit {
                        note_id: h.note_id,
                        note_path: h.note_path,
                        chunk_id: h.chunk_id,
                        heading_path: h.heading_path,
                        snippet: h.snippet,
                        score: -h.rank,
                        score_breakdown: None,
                    })
                    .collect());
            }
        };
        crate::retrieval::search(&self.index, provider.as_ref(), query, limit).map_err(db_err)
    }

    /// `models.status` (§74, §76).
    pub fn models_status(&self) -> Result<crate::models::ModelStatus, RpcError> {
        let conn = self.index.connection();
        let settings = crate::models::ModelSettings::load(conn);
        let (provider_name, model_path, binary_path, dimension, validation_error) =
            match crate::models::select_provider(&settings) {
                Ok(p) => (
                    p.name().to_string(),
                    settings.embedding_model_path.clone(),
                    settings.embedding_binary_path.clone(),
                    p.dimension(),
                    None,
                ),
                Err(e) => (
                    settings.embedding_provider.clone().unwrap_or_else(|| "hash".to_string()),
                    settings.embedding_model_path.clone(),
                    settings.embedding_binary_path.clone(),
                    0,
                    Some(e.to_string()),
                ),
            };
        let chunks_total: i64 = conn
            .query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0))
            .map_err(db_err)?;
        let chunks_embedded: i64 = conn
            .query_row("SELECT COUNT(*) FROM chunks WHERE embedding IS NOT NULL", [], |r| r.get(0))
            .map_err(db_err)?;
        Ok(crate::models::ModelStatus {
            provider: provider_name,
            model_path,
            binary_path,
            dimension,
            chunks_total,
            chunks_embedded,
            chunks_pending: chunks_total - chunks_embedded,
            validation_error,
        })
    }

    /// Link revalidation after renames/new notes (§68 maintenance).
    pub fn revalidate_links(&self) -> Result<u64, RpcError> {
        crate::knowledge::revalidate_links(self.index.connection()).map_err(db_err)
    }

    // ---- Memory API (§49–55) ----

    pub fn memory_list(
        &self,
        status: Option<&str>,
    ) -> Result<Vec<crate::memory::MemoryEntry>, crate::memory::MemoryApiError> {
        crate::memory::list(self.index.connection(), status).map_err(crate::memory::MemoryApiError::from)
    }

    pub fn memory_accept(
        &self,
        id: &str,
    ) -> Result<crate::memory::MemoryEntry, crate::memory::MemoryApiError> {
        crate::memory::accept(self.index.connection(), id)
    }

    pub fn memory_reject(
        &self,
        id: &str,
    ) -> Result<crate::memory::MemoryEntry, crate::memory::MemoryApiError> {
        crate::memory::reject(self.index.connection(), id)
    }

    pub fn memory_update(
        &self,
        id: &str,
        content: Option<&str>,
        memory_type: Option<&str>,
    ) -> Result<crate::memory::MemoryEntry, crate::memory::MemoryApiError> {
        crate::memory::update(self.index.connection(), id, content, memory_type)
    }

    pub fn memory_supersede(
        &self,
        id: &str,
        content: &str,
        memory_type: Option<&str>,
    ) -> Result<crate::memory::MemoryEntry, crate::memory::MemoryApiError> {
        crate::memory::supersede(self.index.connection(), id, content, memory_type)
    }

    pub fn contradictions_list(
        &self,
    ) -> Result<Vec<crate::memory::ContradictionEntry>, crate::memory::MemoryApiError> {
        crate::memory::contradictions_list(self.index.connection())
            .map_err(crate::memory::MemoryApiError::from)
    }

    pub fn contradiction_resolve(
        &self,
        id: &str,
        resolution: crate::memory::Resolution,
    ) -> Result<String, crate::memory::MemoryApiError> {
        crate::memory::resolve_contradiction(self.index.connection(), id, resolution)
    }

    /// Run contradiction detection (invoked after sync commit; §54).
    pub fn detect_contradictions(&self) -> Result<u64, RpcError> {
        crate::memory::detect_contradictions(self.index.connection()).map_err(db_err)
    }

    /// `brain.ask` (§56–58, §107): classify → assemble context → generate
    /// (locally, when a generate-capable model is configured) → validate
    /// citations → answer. Never acts on the vault; generation failures and
    /// model absence degrade to the deterministic evidence summary (§76).
    pub fn ask(&self, query: &str, limit: Option<usize>) -> Result<crate::reasoning::AskResult, RpcError> {
        if query.trim().is_empty() {
            return Err(RpcError::new(
                ErrorCode::InvalidParams,
                "query must not be empty",
            ));
        }
        let settings = crate::models::ModelSettings::load(self.index.connection());
        let provider: Box<dyn crate::models::ModelProvider> =
            match crate::models::select_provider(&settings) {
                Ok(p) => p,
                Err(e) => {
                    crate::utils::logging::log(
                        crate::utils::logging::Level::Warn,
                        "reasoning",
                        "model unavailable; answering from evidence only",
                        serde_json::json!({ "error": e.to_string() }),
                    );
                    Box::new(crate::models::HashEmbeddingProvider::new())
                }
            };
        let limit = limit.unwrap_or(crate::reasoning::DEFAULT_CONTEXT_LIMIT);
        crate::reasoning::answer(&self.index, provider.as_ref(), query, limit).map_err(db_err)
    }

    // ---- Agent & safety API (§59–66) ----

    /// `agent.plan` — deterministic proposal; nothing is applied.
    pub fn agent_plan(
        &self,
        params: &crate::agent::PlanParams,
    ) -> Result<crate::agent::Plan, crate::agent::AgentApiError> {
        crate::agent::planner::plan(self.index.connection(), params)
    }

    /// `agent.create` — wrap proposed file changes into a previewed operation.
    pub fn agent_create(
        &self,
        request: &str,
        files: Vec<crate::agent::AgentFileInput>,
    ) -> Result<crate::agent::Operation, crate::agent::AgentApiError> {
        crate::agent::operations::prepare(self.index.connection(), request, None, files)
    }

    /// `agent.approve`.
    pub fn agent_approve(&self, id: &str) -> Result<crate::agent::Operation, crate::agent::AgentApiError> {
        crate::agent::operations::approve(self.index.connection(), id)
    }

    /// `agent.reject`.
    pub fn agent_reject(&self, id: &str) -> Result<crate::agent::Operation, crate::agent::AgentApiError> {
        crate::agent::operations::reject(self.index.connection(), id)
    }

    /// `agent.execute` — version-checked (§64); returns apply instructions.
    pub fn agent_execute(
        &self,
        id: &str,
        current: &[(String, String)],
    ) -> Result<(crate::agent::Operation, Vec<crate::agent::ApplyFile>), crate::agent::AgentApiError> {
        crate::agent::operations::execute(self.index.connection(), id, current)
    }

    /// `agent.verify` — record the plugin's post-apply hashes (§59).
    pub fn agent_verify(&self, id: &str, applied: &[(String, String)]) -> Result<String, crate::agent::AgentApiError> {
        crate::agent::operations::verify_applied(self.index.connection(), id, applied)
    }

    /// `agent.rollback` — §65; emits reverse instructions.
    pub fn agent_rollback(
        &self,
        id: &str,
        current: &[(String, String)],
    ) -> Result<(crate::agent::Operation, Vec<crate::agent::ApplyFile>), crate::agent::AgentApiError> {
        crate::agent::operations::rollback(self.index.connection(), id, current)
    }

    /// `operation.list` / `operation.get`.
    pub fn operations_list(&self) -> Result<Vec<crate::agent::Operation>, rusqlite::Error> {
        crate::agent::operations::list(self.index.connection())
    }

    pub fn operation_get(&self, id: &str) -> Result<Option<crate::agent::Operation>, rusqlite::Error> {
        crate::agent::operations::load(self.index.connection(), id)
    }

    /// `activity.list` — audit trail + chain verification (§66).
    pub fn audit_list(&self, limit: usize) -> Result<(Vec<crate::agent::AuditEvent>, bool), rusqlite::Error> {
        let events = crate::agent::audit::list(self.index.connection(), limit)?;
        let valid = crate::agent::audit::verify_chain(self.index.connection())?;
        Ok((events, valid))
    }

    /// `agent.tools` — the §60 registry with the §61 default matrix.
    pub fn agent_tools(&self) -> Vec<crate::protocol::AgentToolDto> {
        crate::agent::TOOLS
            .iter()
            .map(|t| crate::protocol::AgentToolDto {
                name: t.name.to_string(),
                permission: t.permission.as_str().to_string(),
                decision: match crate::agent::PolicyEngine::decision(t.permission) {
                    crate::agent::Decision::Allow => "allow",
                    crate::agent::Decision::Confirm => "confirm",
                    crate::agent::Decision::Denied => "denied",
                }
                .to_string(),
                mutates: t.mutates,
            })
            .collect()
    }
}

fn no_session() -> RpcError {
    RpcError::new(
        ErrorCode::InvalidParams,
        "no active sync session; call vault.sync.begin first",
    )
}

fn session_mismatch() -> RpcError {
    RpcError::new(
        ErrorCode::InvalidParams,
        "session_id does not match the active session",
    )
}

fn db_err(e: rusqlite::Error) -> RpcError {
    RpcError::new(ErrorCode::Internal, format!("database error: {e}"))
}

/// SHA-256 hex of content — the single hash definition for the whole system.
pub fn hash_content(content: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}
