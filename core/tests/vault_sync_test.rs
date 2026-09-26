//! Unit tests for the sync engine: diff classification, rename detection,
//! note identity, completeness validation, rebuild semantics.

use sovereign_core::vault::extract::extract_metadata;
use sovereign_core::vault::manager::{hash_content, SyncManager, SyncNoteParams};
use sovereign_core::vault::types::{SyncBatchParams, SyncNote};

fn manager() -> std::sync::Arc<SyncManager> {
    let dir = std::env::temp_dir().join(format!(
        "sv-sync-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    SyncManager::new(&dir)
}

fn note(path: &str, content: &str) -> SyncNote {
    SyncNote {
        path: path.to_string(),
        hash: hash_content(content),
        mtime: 1_000,
        size: content.len() as u64,
        content: None,
    }
}

fn note_with_content(path: &str, content: &str) -> SyncNote {
    SyncNote { content: Some(content.to_string()), ..note(path, content) }
}

#[test]
fn initial_sync_flow_persists_state() {
    let m = manager();
    let s = m.begin(false).unwrap();
    m.batch(&SyncBatchParams {
        session_id: s.session_id.clone(),
        notes: vec![note("A.md", "hello"), note("B.md", "world")],
    })
    .unwrap();
    let commit = m.commit(&s.session_id).unwrap();
    assert_eq!(commit.added.len(), 2);
    assert_eq!(commit.to_fetch.len(), 2);

    for (path, content) in [("A.md", "hello"), ("B.md", "world")] {
        let r = m
            .note(&SyncNoteParams {
                session_id: &s.session_id,
                note: &note_with_content(path, content),
            })
            .unwrap();
        assert!(!r.updated);
    }

    let finish = m.finish(&s.session_id).unwrap();
    assert_eq!(finish.total_notes, 2);
    assert!(finish.persisted);
    assert_eq!(m.total_notes(), 2);
}

#[test]
fn incremental_diff_classifies_add_modify_delete() {
    let m = manager();
    let s = m.begin(false).unwrap();
    m.batch(&SyncBatchParams {
        session_id: s.session_id.clone(),
        notes: vec![note("A.md", "v1"), note("B.md", "same")],
    })
    .unwrap();
    let c1 = m.commit(&s.session_id).unwrap();
    for n in [note_with_content("A.md", "v1"), note_with_content("B.md", "same")] {
        m.note(&SyncNoteParams { session_id: &s.session_id, note: &n }).unwrap();
    }
    m.finish(&s.session_id).unwrap();

    // Second sync: A modified, B unchanged, C added.
    let s2 = m.begin(false).unwrap();
    m.batch(&SyncBatchParams {
        session_id: s2.session_id.clone(),
        notes: vec![note("A.md", "v2"), note("B.md", "same"), note("C.md", "new")],
    })
    .unwrap();
    let c2 = m.commit(&s2.session_id).unwrap();
    assert_eq!(c2.added, vec!["C.md".to_string()]);
    assert_eq!(c2.modified, vec!["A.md".to_string()]);
    assert!(c2.renamed.is_empty());

    // Upload requested content and close the session before the next sync.
    for n in [note_with_content("A.md", "v2"), note_with_content("C.md", "new")] {
        m.note(&SyncNoteParams { session_id: &s2.session_id, note: &n }).unwrap();
    }
    m.finish(&s2.session_id).unwrap();

    // Third sync: A deleted.
    let s3 = m.begin(false).unwrap();
    m.batch(&SyncBatchParams {
        session_id: s3.session_id.clone(),
        notes: vec![note("B.md", "same"), note("C.md", "new")],
    })
    .unwrap();
    let c3 = m.commit(&s3.session_id).unwrap();
    assert_eq!(c3.deleted, vec!["A.md".to_string()]);
    assert_eq!(c3.applied, 1);
    m.finish(&s3.session_id).unwrap();
    assert_eq!(m.total_notes(), 2);
}

#[test]
fn rename_preserves_note_identity() {
    let m = manager();
    let s = m.begin(false).unwrap();
    m.batch(&SyncBatchParams {
        session_id: s.session_id.clone(),
        notes: vec![note("old/Note.md", "content")],
    })
    .unwrap();
    let _ = m.commit(&s.session_id).unwrap();
    let r = m
        .note(&SyncNoteParams {
            session_id: &s.session_id,
            note: &note_with_content("old/Note.md", "content"),
        })
        .unwrap();
    let original_id = r.note_id.clone();
    m.finish(&s.session_id).unwrap();

    // Rename: same hash, new path.
    let s2 = m.begin(false).unwrap();
    m.batch(&SyncBatchParams {
        session_id: s2.session_id.clone(),
        notes: vec![note("new/Note.md", "content")],
    })
    .unwrap();
    let c2 = m.commit(&s2.session_id).unwrap();
    assert_eq!(c2.renamed.len(), 1);
    assert_eq!(c2.renamed[0].from, "old/Note.md");
    assert_eq!(c2.renamed[0].to, "new/Note.md");
    // Renames require no re-upload.
    assert!(c2.to_fetch.is_empty());
    let state = m.state_get(false);
    assert_eq!(state.notes[0].note_id, original_id);
    assert_eq!(state.notes[0].path, "new/Note.md");
    m.finish(&s2.session_id).unwrap();
}

#[test]
fn note_identity_is_stable_across_modifications() {
    let m = manager();
    let s = m.begin(false).unwrap();
    m.batch(&SyncBatchParams {
        session_id: s.session_id.clone(),
        notes: vec![note("A.md", "v1")],
    })
    .unwrap();
    let _ = m.commit(&s.session_id).unwrap();
    let id1 = m
        .note(&SyncNoteParams {
            session_id: &s.session_id,
            note: &note_with_content("A.md", "v1"),
        })
        .unwrap()
        .note_id;
    m.finish(&s.session_id).unwrap();

    let s2 = m.begin(false).unwrap();
    m.batch(&SyncBatchParams {
        session_id: s2.session_id.clone(),
        notes: vec![note("A.md", "v2")],
    })
    .unwrap();
    let _ = m.commit(&s2.session_id).unwrap();
    let id2 = m
        .note(&SyncNoteParams {
            session_id: &s2.session_id,
            note: &note_with_content("A.md", "v2"),
        })
        .unwrap()
        .note_id;
    m.finish(&s2.session_id).unwrap();
    assert_eq!(id1, id2);
}

#[test]
fn hash_mismatch_is_rejected() {
    let m = manager();
    let s = m.begin(false).unwrap();
    m.batch(&SyncBatchParams {
        session_id: s.session_id.clone(),
        notes: vec![note("A.md", "real content")],
    })
    .unwrap();
    let _ = m.commit(&s.session_id).unwrap();

    let mut bad = note_with_content("A.md", "real content");
    bad.hash = hash_content("different content");
    let err = m
        .note(&SyncNoteParams { session_id: &s.session_id, note: &bad })
        .unwrap_err();
    assert!(err.message.contains("hash mismatch"));
    // State must remain clean: finish fails while the note is missing.
    let fin = m.finish(&s.session_id);
    assert!(fin.is_err());
}

#[test]
fn finish_fails_while_requested_notes_are_missing() {
    let m = manager();
    let s = m.begin(false).unwrap();
    m.batch(&SyncBatchParams {
        session_id: s.session_id.clone(),
        notes: vec![note("A.md", "x")],
    })
    .unwrap();
    let _ = m.commit(&s.session_id).unwrap();
    let err = m.finish(&s.session_id).unwrap_err();
    assert!(err.message.contains("were not uploaded"));
}

#[test]
fn session_lifecycle_is_enforced() {
    let m = manager();
    // Methods before begin fail.
    assert!(m.commit("x").is_err());
    assert!(m.finish("x").is_err());

    let s = m.begin(false).unwrap();
    // A new begin abandons the previous session (crash recovery).
    let s2 = m.begin(false).unwrap();
    assert_ne!(s.session_id, s2.session_id);
    // The old session id is now dead.
    assert!(m.commit(&s.session_id).is_err());
    // Wrong session id fails.
    assert!(m.commit("wrong").is_err());
    m.finish(&s2.session_id).unwrap();
    // After finish, the old session is dead.
    assert!(m.finish(&s.session_id).is_err());
}

#[test]
fn rebuild_wipes_derived_state_only() {
    let m = manager();
    let s = m.begin(false).unwrap();
    m.batch(&SyncBatchParams {
        session_id: s.session_id.clone(),
        notes: vec![note("A.md", "x")],
    })
    .unwrap();
    let _ = m.commit(&s.session_id).unwrap();
    m.note(&SyncNoteParams {
        session_id: &s.session_id,
        note: &note_with_content("A.md", "x"),
    })
    .unwrap();
    m.finish(&s.session_id).unwrap();
    assert_eq!(m.total_notes(), 1);

    assert!(m.rebuild());
    assert_eq!(m.total_notes(), 0);
    // A fresh sync starts from zero.
    let s2 = m.begin(true).unwrap();
    m.batch(&SyncBatchParams {
        session_id: s2.session_id.clone(),
        notes: vec![],
    })
    .unwrap();
    let c = m.commit(&s2.session_id).unwrap();
    assert!(c.added.is_empty() && c.deleted.is_empty());
    m.finish(&s2.session_id).unwrap();
    assert_eq!(m.total_notes(), 0);
}

#[test]
fn metadata_extraction_titles_tags_links() {
    let content = "---\ntitle: My Note\ntags: [rust, local-first]\n---\n# Ignored, fm wins\n\nSee [[Other Note#Section|alias]] and [[Second]]. #inline_tag\n\n```rust\nlet x = \"[[not a link]]\";\n```\n";
    let meta = extract_metadata(content);
    assert_eq!(meta.title.as_deref(), Some("My Note"));
    assert!(meta.tags.contains(&"rust".to_string()));
    assert!(meta.tags.contains(&"local-first".to_string()));
    assert!(meta.tags.contains(&"inline_tag".to_string()));
    assert!(meta.links.contains(&"Other Note".to_string()));
    assert!(meta.links.contains(&"Second".to_string()));
    assert!(!meta.links.iter().any(|l| l.contains("not a link")));
}

#[test]
fn excerpt_is_truncated_and_never_the_whole_note() {
    let content = format!("Intro line.\n{}\n", "x".repeat(500));
    let meta = extract_metadata(&content);
    assert!(meta.excerpt.len() <= 200);
}
