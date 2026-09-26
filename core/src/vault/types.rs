//! Vault sync protocol types (PLAN.md §37–39, §88–89).
//!
//! Shared with the plugin side; the plugin is the only component that reads
//! the vault, the core only ever receives content over IPC.

use serde::{Deserialize, Serialize};

/// One note as reported by the plugin.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SyncNote {
    /// Vault-relative path with forward slashes.
    pub path: String,
    /// SHA-256 hex of the file content (plugin-computed).
    pub hash: String,
    /// Modification time, epoch millis.
    pub mtime: u64,
    /// File size in bytes.
    pub size: u64,
    /// Full content (present in `vault.sync.note` only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

/// Begin a sync session.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, default)]
pub struct SyncBeginParams {
    /// Set to wipe derived state and resync everything (rebuild).
    pub rebuild: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SyncBeginResult {
    pub session_id: String,
    pub rebuild: bool,
}

/// One inventory chunk.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, default)]
pub struct SyncBatchParams {
    pub session_id: String,
    pub notes: Vec<SyncNote>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SyncBatchResult {
    pub received: u64,
}

/// Commit: core diffs inventory against state and replies with what it needs.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, default)]
pub struct SyncCommitParams {
    pub session_id: String,
}

/// Classification of each path in the diff.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PendingChange {
    pub path: String,
    pub change: ChangeKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    /// Path is unknown to the core.
    Added,
    /// Content hash differs from stored state.
    Modified,
    /// Same hash at a new path: rename (identity carries over).
    Renamed,
    /// Path was known, now gone.
    Deleted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SyncCommitResult {
    /// Human-readable diff summary (paths only, no content — §97).
    pub added: Vec<String>,
    pub modified: Vec<String>,
    pub renamed: Vec<RenamePair>,
    pub deleted: Vec<String>,
    /// Paths whose full content the core needs (`vault.sync.note` calls).
    pub to_fetch: Vec<String>,
    /// Applied immediately at commit: deletions and rename re-links.
    pub applied: u64,
}

/// Old path → new path for a detected rename.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RenamePair {
    pub from: String,
    pub to: String,
}

/// Upload full content for one requested path.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SyncNoteParams {
    pub session_id: String,
    #[serde(flatten)]
    pub note: SyncNote,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SyncNoteResult {
    pub path: String,
    pub note_id: String,
    /// True when this upload completed an incremental update (vs. initial).
    pub updated: bool,
}

/// Finish and persist the session.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, default)]
pub struct SyncFinishParams {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SyncFinishResult {
    /// Number of notes known to the core after this sync.
    pub total_notes: u64,
    /// Whether state was written to disk.
    pub persisted: bool,
}

/// Read back the core's current sync state (paths and identity only).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, default)]
pub struct StateGetParams {
    pub include_metadata: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StateGetResult {
    pub total_notes: u64,
    pub notes: Vec<StateNoteEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StateNoteEntry {
    pub note_id: String,
    pub path: String,
    pub content_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

/// Rebuild: wipe derived state; the next sync repopulates from the vault.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, default)]
pub struct RebuildParams {}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RebuildResult {
    pub cleared: bool,
    pub message: String,
}
