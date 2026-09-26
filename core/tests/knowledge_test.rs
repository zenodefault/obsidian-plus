//! Knowledge layer tests (§45–48, §68–69): extraction, provenance,
//! idempotent re-index, relationships, health detection.

use sovereign_core::indexing::NoteIndex;
use sovereign_core::knowledge::{extract, find_duplicates, ClaimType};

fn index() -> NoteIndex {
    let dir = std::env::temp_dir().join(format!(
        "sv-know-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    NoteIndex::open(&dir).unwrap()
}

// ---------- Extraction ----------

#[test]
fn extract_finds_entities_from_tags_and_links() {
    let content = "---\ntags: [rust, sqlite]\n---\n\nLearning [[Distributed Systems]] today. #local-first\n";
    let k = extract(content, Some("My Note"));
    let names: Vec<&str> = k.entities.iter().map(|e| e.name.as_str()).collect();
    assert!(names.contains(&"rust"));
    assert!(names.contains(&"sqlite"));
    assert!(names.contains(&"Distributed Systems"));
    assert!(names.contains(&"local-first"));
    assert!(names.contains(&"My Note"), "note title becomes a DOCUMENT entity");
    assert_eq!(k.link_targets, vec!["Distributed Systems".to_string()]);
}

#[test]
fn claims_are_typed_by_markers() {
    let content = "We decided to use SQLite for storage. \
                   I might consider Rust for the parser. \
                   I prefer local-first software. \
                   My goal is learning distributed systems. \
                   The build failed yesterday because of a missing symbol. \
                   What should the schema look like?\n";
    let k = extract(content, Some("Decisions"));
    let by_type: Vec<ClaimType> = k.claims.iter().map(|c| c.claim_type).collect();
    assert!(by_type.contains(&ClaimType::Decision));
    assert!(by_type.contains(&ClaimType::Hypothesis));
    assert!(by_type.contains(&ClaimType::Preference));
    assert!(by_type.contains(&ClaimType::Goal));
    assert!(by_type.contains(&ClaimType::Experience));
    assert!(by_type.contains(&ClaimType::Question));
}

#[test]
fn negation_flips_polarity_and_preserves_uncertainty() {
    // §51: never convert "I might use Rust" into "user prefers Rust".
    let content = "I might use Rust for this project.\n\nI do not prefer cloud services.\n";
    let k = extract(content, Some("Prefs"));
    let hyp = k
        .claims
        .iter()
        .find(|c| c.claim_type == ClaimType::Hypothesis)
        .expect("uncertain statement stays a hypothesis");
    assert_eq!(hyp.object.contains("might use Rust"), true);

    let pref = k
        .claims
        .iter()
        .find(|c| c.claim_type == ClaimType::Preference)
        .expect("preference found");
    assert_eq!(pref.polarity, -1, "negation flips polarity");
}

#[test]
fn claims_carry_source_offsets() {
    let content = "First sentence is plain. We decided to use Postgres.\n";
    let k = extract(content, Some("T"));
    let decision = k
        .claims
        .iter()
        .find(|c| c.claim_type == ClaimType::Decision)
        .unwrap();
    assert!(decision.source_offset > 0, "offset points into the note");
    assert!(content[decision.source_offset..].starts_with("We decided"));
}

#[test]
fn relationships_extracted_from_link_sentences() {
    let content = "This project uses [[Rust]] for the core.\n";
    let k = extract(content, Some("Sovereign"));
    assert!(
        k.relationships
            .iter()
            .any(|(_s, p, t)| p == "uses" && t == "Rust"),
        "expected uses→Rust edge, got {:?}",
        k.relationships
    );
}

#[test]
fn code_blocks_and_frontmatter_are_not_claim_sources() {
    let content = "---\ntitle: X\n---\n\n```text\nWe decided to use nothing.\n```\n\nReal prose. We chose A over B.\n";
    let k = extract(content, Some("X"));
    for c in &k.claims {
        assert!(
            !c.object.contains("```"),
            "code fence must not become a claim"
        );
    }
    assert!(k.claims.iter().any(|c| c.object.contains("chose A")));
}

// ---------- Persistence + idempotence ----------

#[test]
fn persist_creates_entities_claims_and_is_idempotent() {
    let idx = index();
    let content = "---\ntags: [rust]\n---\n\nWe decided to use [[Rust]].\n";
    let note_id = idx.upsert_note("A.md", content, 1, content.len() as i64).unwrap();

    let conn = idx.connection();
    let entity_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM entities", [], |r| r.get(0))
        .unwrap();
    let claim_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM claims WHERE source_note_id = ?1", [&note_id], |r| r.get(0))
        .unwrap();
    assert!(entity_count >= 1);
    assert!(claim_count >= 1);

    // Re-index the same note: nothing duplicates.
    idx.upsert_note("A.md", content, 2, content.len() as i64).unwrap();
    let entity_count2: i64 = conn
        .query_row("SELECT COUNT(*) FROM entities", [], |r| r.get(0))
        .unwrap();
    let claim_count2: i64 = conn
        .query_row("SELECT COUNT(*) FROM claims WHERE source_note_id = ?1", [&note_id], |r| r.get(0))
        .unwrap();
    assert_eq!(entity_count, entity_count2, "entity canonicalization is stable");
    assert_eq!(claim_count, claim_count2, "claims are replaced per note");

    // source_count does not double-count on re-index.
    let total_sources: i64 = conn
        .query_row("SELECT SUM(source_count) FROM entities", [], |r| r.get(0))
        .unwrap();
    idx.upsert_note("A.md", content, 3, content.len() as i64).unwrap();
    let total_sources2: i64 = conn
        .query_row("SELECT SUM(source_count) FROM entities", [], |r| r.get(0))
        .unwrap();
    assert_eq!(total_sources, total_sources2);
}

#[test]
fn deleting_note_removes_its_knowledge() {
    let idx = index();
    idx.upsert_note("A.md", "We decided to use [[Rust]]. #rust", 1, 30 as i64).unwrap();
    assert!(idx.delete_note("A.md").unwrap());
    let conn = idx.connection();
    let claims: i64 = conn.query_row("SELECT COUNT(*) FROM claims", [], |r| r.get(0)).unwrap();
    let rels: i64 = conn.query_row("SELECT COUNT(*) FROM relationships", [], |r| r.get(0)).unwrap();
    let mentions: i64 = conn.query_row("SELECT COUNT(*) FROM entity_mentions", [], |r| r.get(0)).unwrap();
    assert_eq!(claims, 0);
    assert_eq!(rels, 0);
    assert_eq!(mentions, 0);
}

#[test]
fn links_resolve_and_detect_broken() {
    let idx = index();
    idx.upsert_note("A.md", "See [[B]] for details.", 1, 22).unwrap();
    // B.md does not exist yet → broken.
    let conn = idx.connection();
    let broken: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM note_links WHERE resolved_note_id IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(broken, 1);

    // Create B.md and revalidate → link resolves (§68 maintenance).
    idx.upsert_note("B.md", "Target content.", 2, 15 as i64).unwrap();
    let n = sovereign_core::knowledge::revalidate_links(conn).unwrap();
    assert!(n >= 1);
    let broken2: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM note_links WHERE resolved_note_id IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(broken2, 0);
}

// ---------- Health ----------

#[test]
fn health_summary_counts_and_detects() {
    let idx = index();
    idx.upsert_note(
        "Projects/A.md",
        "Project overview. We decided to track [[Missing Note]] and [[B]].",
        1,
        67,
    )
    .unwrap();
    idx.upsert_note("Projects/B.md", "Linked from A.", 2, 15 as i64).unwrap();
    // Second copy of B content → duplicate candidate (§69).
    idx.upsert_note("Archive/B-copy.md", "Linked from A.", 3, 15 as i64).unwrap();

    let conn = idx.connection();
    let s = sovereign_core::health::summary(conn).unwrap();
    assert_eq!(s.total_notes, 3);
    assert!(s.total_chunks >= 3);
    assert!(s.total_claims >= 1);
    assert!(
        s.broken_links.iter().any(|f| f.detail == "Missing Note"),
        "broken link detected"
    );
    assert!(
        s.duplicate_candidates
            .iter()
            .any(|d| d.similarity == 1.0),
        "exact duplicate detected"
    );
}

#[test]
fn duplicates_are_reported_never_deleted() {
    let idx = index();
    idx.upsert_note("X.md", "exact same words", 1, 16 as i64).unwrap();
    idx.upsert_note("Y.md", "exact same words", 2, 16 as i64).unwrap();
    let conn = idx.connection();
    let dupes = find_duplicates(conn).unwrap();
    assert_eq!(dupes.len(), 1);
    // Both notes still exist — detection only (§69).
    assert_eq!(idx.total_notes().unwrap(), 2);
}

#[test]
fn entity_canonicalization_merges_case_variants() {
    let idx = index();
    idx.upsert_note("A.md", "Notes about [[Rust]] here.", 1, 26 as i64).unwrap();
    idx.upsert_note("B.md", "Also mentions [[rust]] today.", 2, 29 as i64).unwrap();
    let conn = idx.connection();
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM entities WHERE lower(canonical_name) = 'rust'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1, "case variants merge into one entity");
    let sources: i64 = conn
        .query_row(
            "SELECT source_count FROM entities WHERE lower(canonical_name) = 'rust'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(sources, 2);
}
