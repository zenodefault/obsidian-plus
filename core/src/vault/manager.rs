//! Sync engine: session lifecycle, inventory diff, rename detection, identity.
//!
//! The plugin owns the vault (§4.1, §89); this manager only maintains derived
//! state. All classification is deterministic and unit-testable (§7).

use crate::protocol::{ErrorCode, RpcError};
use crate::storage::state_store::{now_millis, NoteState, StateStore, VaultState};
use crate::vault::types::{
    RenamePair, StateGetResult, StateNoteEntry, SyncBatchParams, SyncBeginResult, SyncCommitResult,
    SyncFinishResult, SyncNote, SyncNoteResult,
};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

/// One inventory entry recorded during a sync session.
#[derive(Debug, Clone, PartialEq)]
struct InventoryEntry {
    hash: String,
    #[allow(dead_code)]
    mtime: u64,
    #[allow(dead_code)]
    size: u64,
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

/// Owns sync state and active sessions. Shared behind `Arc`.
pub struct SyncManager {
    store: StateStore,
    state: Mutex<VaultState>,
    session: Mutex<Option<Session>>,
}

impl SyncManager {
    pub fn new(data_dir: &Path) -> Arc<Self> {
        let store = StateStore::new(data_dir);
        let state = store.load();
        Arc::new(Self {
            store,
            state: Mutex::new(state),
            session: Mutex::new(None),
        })
    }

    /// Number of notes currently known (for tests and health surfaces).
    pub fn total_notes(&self) -> u64 {
        self.lock_state().notes.len() as u64
    }

    /// `vault.sync.begin` — open a session, honouring rebuild.
    ///
    /// A still-active previous session is abandoned (not rolled back): with a
    /// single plugin client, a new `begin` proves the old session is garbage
    /// after a crash or failure. Uncommitted uploads remain in memory as the
    /// live truth; nothing was persisted.
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
                    mtime: note.mtime,
                    size: note.size,
                },
            );
        }
        Ok(params.notes.len() as u64)
    }

    /// `vault.sync.commit` — diff inventory vs state, detect renames, apply
    /// deletions, and return the list of paths whose content is needed.
    pub fn commit(&self, session_id: &str) -> Result<SyncCommitResult, RpcError> {
        let mut session = self.lock_session();
        let Some(s) = session.as_mut() else {
            return Err(no_session());
        };
        if s.session_id != session_id {
            return Err(session_mismatch());
        }

        let mut state = self.lock_state();
        let inventory_paths: HashSet<&String> = s.inventory.keys().collect();

        // First pass: classify.
        let mut added: Vec<String> = Vec::new();
        let mut modified: Vec<String> = Vec::new();
        let mut deleted: Vec<String> = Vec::new();

        for path in s.inventory.keys() {
            match state.notes.get(path) {
                None => added.push(path.clone()),
                Some(existing) => {
                    if existing.content_hash != s.inventory[path].hash {
                        modified.push(path.clone());
                    }
                }
            }
        }
        for path in state.notes.keys() {
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
                    !consumed_deleted.contains(*old)
                        && state
                            .notes
                            .get(*old)
                            .is_some_and(|n| n.content_hash == entry.hash)
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

        // Apply renames: carry identity forward, drop the old entry.
        for pair in &renames {
            if let Some(mut old_state) = state.notes.remove(&pair.from) {
                old_state.path = pair.to.clone();
                old_state.synced_at = now_millis();
                state.notes.insert(pair.to.clone(), old_state);
            }
        }

        // Apply true deletions (paths not matched as renames).
        for path in &deleted {
            if !consumed_deleted.contains(path) {
                state.notes.remove(path);
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

        Ok(SyncCommitResult {
            added: added.into_iter().filter(|p| !rename_targets.contains(p)).collect(),
            modified,
            renamed: renames,
            deleted: deleted.into_iter().filter(|p| !consumed_deleted.contains(p)).collect(),
            to_fetch,
            applied,
        })
    }

    /// `vault.sync.note` — receive full content for one requested path.
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
        let actual = hash_content(content);
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

        let mut state = self.lock_state();
        let updated = state.notes.contains_key(&note.path);
        let note_id = match state.notes.get(&note.path) {
            Some(existing) => existing.note_id.clone(),
            None => Uuid::new_v4().to_string(),
        };
        state.notes.insert(
            note.path.clone(),
            NoteState::from_note(note, note_id.clone()),
        );

        if let Some(pending) = s.pending.as_mut() {
            pending.to_fetch.retain(|p| p != &note.path);
        }

        Ok(SyncNoteResult {
            path: note.path.clone(),
            note_id,
            updated,
        })
    }

    /// `vault.sync.finish` — validate completeness, persist state.
    pub fn finish(&self, session_id: &str) -> Result<SyncFinishResult, RpcError> {
        {
            let mut session = self.lock_session();
            let Some(s) = session.as_mut() else {
                return Err(no_session());
            };
            if s.session_id != session_id {
                return Err(session_mismatch());
            }
            // Content completeness: every requested path must have been sent.
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

        let state = self.lock_state();
        let persisted = self.store.save(&state).is_ok();
        if !persisted {
            crate::utils::logging::log(
                crate::utils::logging::Level::Error,
                "sync",
                "failed to persist vault state",
                serde_json::json!({}),
            );
        }
        Ok(SyncFinishResult {
            total_notes: state.notes.len() as u64,
            persisted,
        })
    }

    /// `vault.state.get`.
    pub fn state_get(&self, include_metadata: bool) -> StateGetResult {
        let state = self.lock_state();
        let mut notes: Vec<StateNoteEntry> = state
            .notes
            .values()
            .map(|n| StateNoteEntry {
                note_id: n.note_id.clone(),
                path: n.path.clone(),
                content_hash: n.content_hash.clone(),
                title: if include_metadata { n.title.clone() } else { None },
                tags: if include_metadata { n.tags.clone() } else { Vec::new() },
            })
            .collect();
        notes.sort_by(|a, b| a.path.cmp(&b.path));
        StateGetResult {
            total_notes: notes.len() as u64,
            notes,
        }
    }

    /// `vault.rebuild` — wipe derived state; vault is untouched (§9, §90).
    pub fn rebuild(&self) -> bool {
        self.reset_state();
        self.store.clear().is_ok()
    }

    fn reset_state(&self) {
        *self.lock_state() = VaultState::current();
        let _ = self.store.clear();
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, VaultState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
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

/// SHA-256 hex of content — the single hash definition for the whole system.
pub fn hash_content(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    hex(&hasher.finalize())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
