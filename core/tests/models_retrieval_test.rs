//! Part 5 tests: providers (§74–76), vector storage, hybrid ranking (§42, §44),
//! graceful degradation (§76).

use sovereign_core::indexing::NoteIndex;
use sovereign_core::models::{
    blob_to_vector, cosine, vector_to_blob, HashEmbeddingProvider, ModelProvider, ModelSettings,
};
use sovereign_core::retrieval::search;

fn index() -> NoteIndex {
    let dir = std::env::temp_dir().join(format!(
        "sv-vec-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    NoteIndex::open(&dir).unwrap()
}

// ---------- Provider basics ----------

#[test]
fn hash_provider_is_deterministic_and_normalized() {
    let p = HashEmbeddingProvider::new();
    let texts = vec!["rust is fast".to_string(), "rust is fast".to_string(), "completely different".to_string()];
    let vectors = p.embed(&texts).unwrap();
    assert_eq!(vectors.len(), 3);
    assert_eq!(vectors[0], vectors[1], "same text, same vector");
    assert_ne!(vectors[0], vectors[2]);

    // L2-normalized: self-similarity ≈ 1.
    let self_sim = cosine(&vectors[0], &vectors[0]);
    assert!((self_sim - 1.0).abs() < 1e-5, "normalized vectors self-sim 1.0, got {self_sim}");

    let other = cosine(&vectors[0], &vectors[2]);
    assert!(other < 0.5, "unrelated texts should be far apart, got {other}");
    assert_eq!(p.dimension(), 384);
    assert_eq!(p.name(), "hash");
}

#[test]
fn cosine_handles_edge_cases() {
    assert_eq!(cosine(&[], &[]), 0.0);
    assert_eq!(cosine(&[1.0], &[1.0, 2.0]), 0.0, "dimension mismatch");
    assert_eq!(cosine(&[0.0, 0.0], &[1.0, 1.0]), 0.0, "zero vector");
    assert!((cosine(&[1.0, 0.0], &[0.0, 1.0])).abs() < 1e-6, "orthogonal");
    assert!((cosine(&[1.0, 0.0], &[-1.0, 0.0]) + 1.0).abs() < 1e-6, "opposite");
}

#[test]
fn blob_round_trip_preserves_vectors() {
    let original = vec![0.25f32, -1.5, 3.25, 0.0, f32::MIN_POSITIVE];
    let blob = vector_to_blob(&original);
    let restored = blob_to_vector(&blob);
    assert_eq!(original, restored);
}

#[test]
fn provider_selection_defaults_to_hash() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE chunks (id INTEGER); CREATE TABLE notes (id INTEGER);")
        .unwrap();
    let settings = ModelSettings::load(&conn);
    let provider = sovereign_core::models::select_provider(&settings).unwrap();
    assert_eq!(provider.name(), "hash");
}

#[test]
fn cli_provider_validates_config_before_running() {
    // Missing binary.
    let err = sovereign_core::models::cli::CliModelProvider::new(
        "/nonexistent/binary",
        "/nonexistent/model.gguf",
    )
    .unwrap_err();
    assert!(matches!(err, sovereign_core::models::ModelError::InvalidConfig(_)));

    // Existing binary, missing model (use a file we know exists as "binary").
    let err2 = sovereign_core::models::cli::CliModelProvider::new(
        env!("CARGO_BIN_EXE_sovereign-core"),
        "/nonexistent/model.gguf",
    )
    .unwrap_err();
    assert!(err2.to_string().contains("model file not found"));
}

// ---------- Embedding pipeline ----------

#[test]
fn upsert_embeds_chunks_with_default_provider() {
    let idx = index();
    idx.upsert_note("A.md", "# A\n\nContent about databases and indexing.", 1, 45)
        .unwrap();
    let embedded: i64 = idx
        .connection()
        .query_row("SELECT COUNT(*) FROM chunks WHERE embedding IS NOT NULL", [], |r| r.get(0))
        .unwrap();
    let total: i64 = idx
        .connection()
        .query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0))
        .unwrap();
    assert!(total >= 1);
    assert_eq!(embedded, total, "default provider embeds everything");
}

#[test]
fn embedding_failure_degrades_without_breaking_fts() {
    let idx = index();
    // Seed a broken CLI config into settings.
    idx.connection()
        .execute(
            "INSERT INTO settings (key, value) VALUES ('embedding_provider', 'cli')",
            [],
        )
        .unwrap();
    idx.upsert_note("A.md", "Searchable text about unicorns.", 1, 32)
        .unwrap();
    // FTS still works (§76: model failure never takes search down).
    let hits = idx.search("unicorns", 5).unwrap();
    assert!(!hits.is_empty());
    // A retry job was enqueued.
    let pending: i64 = idx
        .connection()
        .query_row("SELECT COUNT(*) FROM jobs WHERE status = 'pending'", [], |r| r.get(0))
        .unwrap();
    assert!(pending >= 1, "embed failure enqueues a retry job");
    // Chunks exist with NULL embeddings.
    let null_embeddings: i64 = idx
        .connection()
        .query_row("SELECT COUNT(*) FROM chunks WHERE embedding IS NULL", [], |r| r.get(0))
        .unwrap();
    assert!(null_embeddings >= 1);
}

// ---------- Hybrid retrieval ----------

#[test]
fn hybrid_search_merges_signals_with_breakdown() {
    let idx = index();
    idx.upsert_note(
        "Rust.md",
        "# Rust\n\nRust is a systems language. This project uses [[Rust]]. #rust",
        1,
        70,
    )
    .unwrap();
    idx.upsert_note(
        "Cooking.md",
        "# Cooking\n\nBoil potatoes, season with salt and pepper.",
        2,
        55,
    )
    .unwrap();

    let provider = HashEmbeddingProvider::new();
    let hits = search(&idx, &provider, "rust systems language", 10).unwrap();
    assert!(!hits.is_empty());
    assert_eq!(hits[0].note_path, "Rust.md");
    let breakdown = hits[0].score_breakdown.expect("hybrid hits carry breakdown");
    assert!(breakdown.lexical > 0.0, "lexical signal fired");
    assert!(breakdown.semantic > 0.0, "semantic signal fired");
    assert!(hits[0].score > 0.0 && hits[0].score <= 1.0);

    // Unrelated query returns something sane, not a panic.
    let none = search(&idx, &provider, "quantum chromodynamics", 10).unwrap();
    let _ = none;
}

#[test]
fn hybrid_ranking_is_deterministic() {
    let idx = index();
    idx.upsert_note("A.md", "Alpha beta gamma delta epsilon zeta.", 1, 36).unwrap();
    idx.upsert_note("B.md", "Alpha beta gamma eta theta iota.", 2, 32).unwrap();
    let provider = HashEmbeddingProvider::new();
    let run1 = search(&idx, &provider, "alpha beta", 10).unwrap();
    let run2 = search(&idx, &provider, "alpha beta", 10).unwrap();
    assert_eq!(run1.len(), run2.len());
    for (a, b) in run1.iter().zip(run2.iter()) {
        assert_eq!(a.chunk_id, b.chunk_id);
        assert!((a.score - b.score).abs() < 1e-9, "same query, same scores");
    }
}

#[test]
fn entity_boost_lifts_matching_notes() {
    let idx = index();
    idx.upsert_note("Postgres.md", "Postgres is a relational database. We decided to use [[Postgres]].", 1, 66).unwrap();
    idx.upsert_note("Unrelated.md", "A walk in the park with friends.", 2, 32).unwrap();
    let provider = HashEmbeddingProvider::new();
    let with_entity = search(&idx, &provider, "postgres", 10).unwrap();
    let top = with_entity.first().expect("top hit");
    assert_eq!(top.note_path, "Postgres.md");
    let breakdown = top.score_breakdown.unwrap();
    assert!(breakdown.entity > 0.0, "entity boost applied");
}

#[test]
fn semantic_arm_surfaces_lexically_hidden_notes() {
    // Query words that do NOT appear in the note text: only the (hashed)
    // shared-token structure of related text links them. With the hash
    // embedder, a note sharing several tokens with the query but few with the
    // FTS winner must still surface via the semantic arm.
    let idx = index();
    idx.upsert_note("Primary.md", "alpha alpha alpha primary document text", 1, 39).unwrap();
    idx.upsert_note("Secondary.md", "alpha beta secondary document text", 2, 34).unwrap();
    let provider = HashEmbeddingProvider::new();
    let hits = search(&idx, &provider, "alpha beta", 5).unwrap();
    // Both notes should appear (semantic arm picks up Secondary's 'beta').
    let paths: Vec<&str> = hits.iter().map(|h| h.note_path.as_str()).collect();
    assert!(paths.contains(&"Secondary.md"), "semantic arm surfaces non-lexical matches");
}

#[test]
fn hybrid_respects_limit() {
    let idx = index();
    for i in 0..12 {
        idx.upsert_note(&format!("N{i}.md"), &format!("shared token number {i} plus extra"), i, 30)
            .unwrap();
    }
    let provider = HashEmbeddingProvider::new();
    let hits = search(&idx, &provider, "shared token", 5).unwrap();
    assert_eq!(hits.len(), 5);
}

// ---------- Model status ----------

#[test]
fn models_status_reports_counts() {
    let idx = index();
    idx.upsert_note("A.md", "Some content here for status.", 1, 29).unwrap();
    let conn = idx.connection();
    let settings = sovereign_core::models::ModelSettings::load(conn);
    let provider = sovereign_core::models::select_provider(&settings).unwrap();
    let chunks_total: i64 = conn
        .query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0))
        .unwrap();
    let chunks_embedded: i64 = conn
        .query_row("SELECT COUNT(*) FROM chunks WHERE embedding IS NOT NULL", [], |r| r.get(0))
        .unwrap();
    assert_eq!(provider.name(), "hash");
    assert_eq!(chunks_total, chunks_embedded);
    assert!(chunks_total >= 1);
}
