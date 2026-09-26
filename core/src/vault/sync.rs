//! Thin wire-format bridge between JSON-RPC dispatch and the sync manager.

use crate::vault::manager::SyncManager;
use crate::vault::types::{SyncBatchParams, SyncNote};
use std::sync::Arc;

/// Decode a `vault.sync.batch` params payload against the manager.
pub fn decode_batch(params: serde_json::Value) -> Result<SyncBatchParams, serde_json::Error> {
    serde_json::from_value(params)
}

/// Validate a note payload shape before it reaches the manager.
pub fn validate_note(note: &SyncNote) -> Result<(), String> {
    if note.path.is_empty() {
        return Err("path must not be empty".to_string());
    }
    if note.path.starts_with('/') {
        return Err("path must be vault-relative".to_string());
    }
    if note.hash.len() != 64 || !note.hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("hash must be 64 hex characters".to_string());
    }
    Ok(())
}

/// Reference to the manager for future wire helpers.
#[allow(dead_code)]
pub type ManagerRef = Arc<SyncManager>;
