//! Atomic JSON document store for sync state.
//!
//! Writes go to a temp file, then rename into place — a crash mid-write never
//! corrupts existing state. This store holds sync metadata only; it never
//! contains note bodies beyond the small metadata excerpt (§97: avoid storing
//! full note text in derived state before Part 3's database exists).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

/// One known note in the core's sync state.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteState {
    /// Permanent identity. Survives renames; never reused (PLAN.md §39).
    pub note_id: String,
    /// Current vault-relative path.
    pub path: String,
    /// SHA-256 of the last synced content (hex).
    pub content_hash: String,
    /// Plugin-reported mtime at last sync (epoch millis).
    pub mtime: u64,
    /// Plugin-reported size at last sync (bytes).
    pub size: u64,
    /// Note title extracted from content/frontmatter.
    pub title: Option<String>,
    /// Tags extracted from frontmatter/body.
    pub tags: Vec<String>,
    /// Wikilink targets extracted from the body.
    pub links: Vec<String>,
    /// Metadata excerpt for review surfaces — never the full body (§97).
    pub excerpt: String,
    /// Epoch millis when this state entry was last updated.
    pub synced_at: u64,
}

impl NoteState {
    /// Build state from a just-synced note payload.
    pub fn from_note(note: &crate::vault::types::SyncNote, note_id: String) -> Self {
        let parsed =
            crate::vault::extract::extract_metadata(note.content.as_deref().unwrap_or(""));
        Self {
            note_id,
            path: note.path.clone(),
            content_hash: note.hash.clone(),
            mtime: note.mtime,
            size: note.size,
            title: parsed.title,
            tags: parsed.tags,
            links: parsed.links,
            excerpt: parsed.excerpt,
            synced_at: now_millis(),
        }
    }
}

/// Root of the persisted sync state document.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct VaultState {
    /// Schema version for future migrations.
    pub version: u32,
    /// All known notes keyed by path.
    pub notes: HashMap<String, NoteState>,
}

impl VaultState {
    pub fn current() -> Self {
        Self {
            version: 1,
            notes: HashMap::new(),
        }
    }
}

/// Atomic JSON document store at a fixed path.
pub struct StateStore {
    path: PathBuf,
}

impl StateStore {
    /// Store file lives under `<data_dir>/cache/vault_state.json`.
    pub fn new(data_dir: &std::path::Path) -> Self {
        Self {
            path: data_dir.join("cache").join("vault_state.json"),
        }
    }

    /// Load state, or a fresh document when nothing is persisted yet.
    pub fn load(&self) -> VaultState {
        match fs::read_to_string(&self.path) {
            Ok(raw) => serde_json::from_str::<VaultState>(&raw).unwrap_or_else(|_| {
                crate::utils::logging::log(
                    crate::utils::logging::Level::Warn,
                    "state_store",
                    "unreadable vault state, starting fresh",
                    serde_json::json!({ "path": self.path.to_string_lossy() }),
                );
                VaultState::current()
            }),
            Err(_) => VaultState::current(),
        }
    }

    /// Persist state atomically (temp file + rename).
    pub fn save(&self, state: &VaultState) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        let raw = serde_json::to_string_pretty(state).map_err(std::io::Error::other)?;
        fs::write(&tmp, raw)?;
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    /// Delete persisted state (used by `vault.rebuild`).
    pub fn clear(&self) -> std::io::Result<()> {
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }
}

/// Epoch milliseconds for `synced_at`.
pub fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
