//! Memory engine tests (§49–55, §108–109): candidate generation guards,
//! lifecycle transitions, provenance, contradictions, stale marking.

use sovereign_core::indexing::NoteIndex;
use sovereign_core::memory::{self, list, Resolution};

fn index() -> NoteIndex {
    let dir = std::env::temp_dir().join(format!(
        "sv-mem-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    NoteIndex::open(&dir).unwrap()
}

fn candidates_of(conn: &rusqlite::Connection) -> Vec<(String, String)> {
    let mut stmt = conn
        .prepare("SELECT id, content FROM memories WHERE status = 'candidate'")
        .unwrap();
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0).unwrap(), r.get::<_, String>(1).unwrap())))
        .unwrap();
    rows.map(|r| r.unwrap()).collect()
}

// ---------- Candidate generation (§50, §51) ----------

#[test]
fn memory_worthy_claims_become_candidates() {
    let idx = index();
    idx.upsert_note(
        "Goals.md",
        "My goal is learning distributed systems. We decided to use Postgres.",
        1,
        70,
    )
    .unwrap();
    let conn = idx.connection();
    let cands = candidates_of(conn);
    assert!(cands.len() >= 2, "goal + decision become candidates");
    assert!(cands.iter().any(|(_, c)| c.contains("learning distributed systems")));
    assert!(cands.iter().any(|(_, c)| c.contains("use Postgres")));
}

#[test]
fn hypotheses_and_questions_never_become_memories() {
    // §51: never convert "I might use Rust" into "user prefers Rust".
    let idx = index();
    idx.upsert_note(
        "Ideas.md",
        "I might use Rust for the next project. What database should I pick? Maybe SQLite perhaps.",
        1,
        92,
    )
    .unwrap();
    let conn = idx.connection();
    let cands = candidates_of(conn);
    assert!(
        cands.is_empty(),
        "hypotheses/questions must not become memories, got {cands:?}"
    );
}

#[test]
fn negated_preference_keeps_verbatim_content() {
    let idx = index();
    idx.upsert_note("Prefs.md", "I do not prefer cloud services.", 1, 31).unwrap();
    let conn = idx.connection();
    let cands = candidates_of(conn);
    let pref = cands.iter().find(|(id, _)| {
        let t: String = conn
            .query_row("SELECT type FROM memories WHERE id = ?1", [id], |r| r.get(0))
            .unwrap();
        t == "preference"
    });
    let (_, content) = pref.expect("negated preference still creates a candidate for review");
    assert_eq!(content, "I do not prefer cloud services.");
}

#[test]
fn wikilinks_are_cleaned_in_content_provenance_keeps_original() {
    let idx = index();
    idx.upsert_note("A.md", "We decided to use [[PostgreSQL/Setup|Postgres]] for storage.", 1, 60)
        .unwrap();
    let conn = idx.connection();
    let cands = candidates_of(conn);
    assert!(!cands.is_empty());
    for (_, content) in &cands {
        assert!(!content.contains("[["), "display content is clean: {content}");
        assert!(content.contains("Postgres"), "alias shown: {content}");
    }
    // Provenance excerpt keeps the original wikilink text (§52).
    let excerpt: String = conn
        .query_row(
            "SELECT ms.excerpt FROM memory_sources ms WHERE ms.excerpt LIKE '%[[%' LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(excerpt.contains("[[PostgreSQL/Setup|Postgres]]"));
}

// ---------- Provenance (§52) ----------

#[test]
fn every_memory_has_sources() {
    let idx = index();
    idx.upsert_note("D.md", "We decided to switch to C++ for the parser.", 1, 44).unwrap();
    let conn = idx.connection();
    let orphan_memories: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memories m WHERE NOT EXISTS (SELECT 1 FROM memory_sources ms WHERE ms.memory_id = m.id)",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(orphan_memories, 0, "§52: no memory without provenance");
}

// ---------- Lifecycle (§50) ----------

#[test]
fn full_lifecycle_accept_reject_supersede() {
    let idx = index();
    idx.upsert_note("G.md", "My goal is learning distributed systems.", 1, 40).unwrap();
    let conn = idx.connection();
    let (id, _) = candidates_of(conn)[0].clone();

    // Accept.
    let accepted = memory::accept(conn, &id).unwrap();
    assert_eq!(accepted.status, "accepted");
    assert!(accepted.user_verified);

    // Idempotent-ish guard: accepting twice is invalid.
    assert!(memory::accept(conn, &id).is_err());

    // Supersede (§109): old → superseded, new → accepted with inherited sources.
    let newer = memory::supersede(conn, &id, "My goal is mastering distributed systems.", None).unwrap();
    assert_eq!(newer.status, "accepted");
    assert!(newer.user_verified);
    assert!(!newer.sources.is_empty(), "superseding inherits provenance");
    let old: String = conn
        .query_row("SELECT status FROM memories WHERE id = ?1", [&id], |r| r.get(0))
        .unwrap();
    assert_eq!(old, "superseded");

    // Superseding a rejected memory fails.
    idx.upsert_note("X.md", "We decided to try VimScript.", 2, 28).unwrap();
    let (xid, _) = candidates_of(conn).iter().find(|(id, c)| c.contains("VimScript")).unwrap().clone();
    memory::reject(conn, &xid).unwrap();
    assert!(memory::supersede(conn, &xid, "New decision", None).is_err());
}

#[test]
fn reject_rejects_and_blocks_lifecycle() {
    let idx = index();
    idx.upsert_note("R.md", "I prefer tea over coffee.", 1, 25).unwrap();
    let conn = idx.connection();
    let (id, _) = candidates_of(conn)[0].clone();
    let rejected = memory::reject(conn, &id).unwrap();
    assert_eq!(rejected.status, "rejected");
    assert!(memory::accept(conn, &id).is_err(), "rejected is terminal for accept");
}

#[test]
fn update_edits_content_and_type() {
    let idx = index();
    idx.upsert_note("U.md", "We decided to adopt GraphQL.", 1, 28).unwrap();
    let conn = idx.connection();
    let (id, _) = candidates_of(conn)[0].clone();
    let updated = memory::update(conn, &id, Some("We decided to adopt gRPC."), Some("decision")).unwrap();
    assert_eq!(updated.content, "We decided to adopt gRPC.");
    assert_eq!(updated.memory_type, "decision");
    assert!(memory::update(conn, &id, None, Some("nonsense")).is_err());
}

// ---------- Stale (§55) ----------

#[test]
fn accepted_memory_goes_stale_when_sources_disappear() {
    let idx = index();
    idx.upsert_note("S.md", "I prefer local-first software.", 1, 30).unwrap();
    let conn = idx.connection();
    let (id, _) = candidates_of(conn)[0].clone();
    memory::accept(conn, &id).unwrap();

    // Delete the source note → memory is stale, NOT deleted (§55).
    idx.delete_note("S.md").unwrap();
    let all = list(conn, None).unwrap();
    let mem = all.iter().find(|m| m.id == id).expect("stale memory still listed");
    assert_eq!(mem.status, "stale");
    assert_eq!(mem.sources.len(), 1, "provenance remains for review");
}

// ---------- Contradictions (§54, §109) ----------

#[test]
fn polarity_flip_creates_contradiction_with_both_sources() {
    let idx = index();
    idx.upsert_note("Old.md", "I prefer Vim for editing.", 1, 25).unwrap();
    idx.upsert_note("New.md", "I do not prefer Vim for editing anymore.", 2, 40).unwrap();
    let conn = idx.connection();
    let found = memory::detect_contradictions(conn).unwrap();
    assert_eq!(found, 1, "same subject+type, opposite polarity");

    let contradictions = memory::contradictions_list(conn).unwrap();
    assert_eq!(contradictions.len(), 1);
    let c = &contradictions[0];
    assert!(c.claim_a.note_path.is_some());
    assert!(c.claim_b.note_path.is_some());
    assert_ne!(c.claim_a.note_path, c.claim_b.note_path, "both sources shown");
    // Deterministic order: earlier note is claim_a.
    assert_eq!(c.claim_a.note_path.as_deref(), Some("Old.md"));

    // Detection is idempotent while open.
    let again = memory::detect_contradictions(conn).unwrap();
    assert_eq!(again, 0);
}

#[test]
fn resolve_mark_later_current_supersedes_old_memory() {
    let idx = index();
    idx.upsert_note("Old.md", "I prefer Vim for editing.", 1, 25).unwrap();
    idx.upsert_note("New.md", "I do not prefer Vim for editing anymore.", 2, 40).unwrap();
    let conn = idx.connection();
    memory::detect_contradictions(conn).unwrap();
    let c = &memory::contradictions_list(conn).unwrap()[0];
    let cid = c.id.clone();

    // Accept the candidate memories first so MarkLaterCurrent has work.
    let cands = candidates_of(conn);
    for (id, _) in &cands {
        memory::accept(conn, id).unwrap();
    }

    let message = memory::resolve_contradiction(conn, &cid, Resolution::MarkLaterCurrent).unwrap();
    assert!(message.contains("later claim marked current"));
    let statuses: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT status, content FROM memories").unwrap();
        stmt.query_map([], |r| Ok((r.get(0).unwrap(), r.get(1).unwrap())))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    };
    assert!(statuses.iter().any(|(s, _)| s == "superseded"));
    assert!(statuses.iter().any(|(s, _)| s == "accepted"));
    // Contradiction closed.
    assert!(memory::contradictions_list(conn).unwrap().is_empty());
}

#[test]
fn resolve_keep_both_and_ignore_close_contradiction() {
    let idx = index();
    idx.upsert_note("Old.md", "I prefer Vim for editing.", 1, 25).unwrap();
    idx.upsert_note("New.md", "I do not prefer Vim for editing anymore.", 2, 40).unwrap();
    let conn = idx.connection();
    memory::detect_contradictions(conn).unwrap();
    let cid = memory::contradictions_list(conn).unwrap()[0].id.clone();
    memory::resolve_contradiction(conn, &cid, Resolution::KeepBoth).unwrap();
    assert!(memory::contradictions_list(conn).unwrap().is_empty());
    // Both memories untouched by KeepBoth.
    assert_eq!(candidates_of(conn).len(), 2);
}

#[test]
fn different_subjects_do_not_contradict() {
    let idx = index();
    idx.upsert_note("A.md", "Project X uses Rust.", 1, 20).unwrap();
    idx.upsert_note("B.md", "I do not prefer cloudy skies.", 2, 29).unwrap();
    let conn = idx.connection();
    assert_eq!(memory::detect_contradictions(conn).unwrap(), 0);
}

// ---------- Sync integration ----------

#[test]
fn sync_finish_runs_detection_and_reindex_preserves_memories() {
    let dir = std::env::temp_dir().join(format!(
        "sv-mem-sync-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let m = sovereign_core::vault::manager::SyncManager::new(&dir);

    let note = |path: &str, content: &str| sovereign_core::vault::types::SyncNote {
        path: path.to_string(),
        hash: sovereign_core::vault::manager::hash_content(content),
        mtime: 1,
        size: content.len() as u64,
        content: Some(content.to_string()),
    };

    // First sync: one memory-worthy note.
    let s = m.begin(false).unwrap();
    let content = "We decided to use Postgres for the project.";
    m.batch(&sovereign_core::vault::types::SyncBatchParams {
        session_id: s.session_id.clone(),
        notes: vec![note("D.md", content)],
    })
    .unwrap();
    m.commit(&s.session_id).unwrap();
    m.note(&sovereign_core::vault::manager::SyncNoteParams {
        session_id: &s.session_id,
        note: &note("D.md", content),
    })
    .unwrap();
    m.finish(&s.session_id).unwrap();

    // Accept the candidate.
    let conn = m.index_connection();
    let (id, _) = candidates_of(conn)[0].clone();
    memory::accept(conn, &id).unwrap();

    // Re-sync with the same note unchanged: the accepted memory survives (§90).
    let s2 = m.begin(false).unwrap();
    m.batch(&sovereign_core::vault::types::SyncBatchParams {
        session_id: s2.session_id.clone(),
        notes: vec![note("D.md", content)],
    })
    .unwrap();
    m.commit(&s2.session_id).unwrap();
    m.finish(&s2.session_id).unwrap();
    let accepted_count = list(conn, Some("accepted")).unwrap().len();
    assert_eq!(accepted_count, 1, "accepted memory survives re-sync (§90)");
}
