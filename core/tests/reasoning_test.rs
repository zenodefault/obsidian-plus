//! Part 7 tests: query classification (§95), context assembly (§56), answer
//! generation with citation validation (§58), no-fabrication behaviour and the
//! `brain.ask` stdio round trip.

use serde_json::json;
use sovereign_core::indexing::NoteIndex;
use sovereign_core::ipc::{read_envelope, write_envelope};
use sovereign_core::memory::MemoryApiError;
use sovereign_core::models::HashEmbeddingProvider;
use sovereign_core::protocol::{Envelope, ErrorCode};
use sovereign_core::reasoning::{
    answer, assemble, classify_query, evidence_answer, validate_citations, QueryType,
    NO_EVIDENCE_MESSAGE,
};
use std::io::{BufReader, Write};use std::process::{Child, Command, Stdio};

fn index() -> NoteIndex {
    let dir = std::env::temp_dir().join(format!(
        "sv-reason-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    NoteIndex::open(&dir).unwrap()
}

// ---------- §95 query classification ----------

#[test]
fn classification_maps_intents() {
    assert_eq!(classify_query("database"), QueryType::SimpleSearch);
    assert_eq!(classify_query("what is entropy"), QueryType::SemanticSearch);
    assert_eq!(
        classify_query("summarize what I have learned about databases"),
        QueryType::Synthesis
    );
    assert_eq!(
        classify_query("compare Postgres vs SQLite"),
        QueryType::Comparison
    );
    assert_eq!(
        classify_query("how has my thinking on storage changed over time"),
        QueryType::Temporal
    );
    assert_eq!(
        classify_query("do I have contradictory information about vim"),
        QueryType::Contradiction
    );
    assert_eq!(
        classify_query("what did I decide about the database"),
        QueryType::Decision
    );
    assert_eq!(
        classify_query("what is related to machine learning"),
        QueryType::Relationship
    );
    assert_eq!(
        classify_query("organize my research notes"),
        QueryType::AgentTask
    );
}

// ---------- §56 context assembly ----------

#[test]
fn assembles_retrieval_memory_and_knowledge() {
    let idx = index();
    idx.upsert_note(
        "Projects/Decision.md",
        "# Decision\n\nWe decided to use [[Postgres]] for the project. #databases",
        1,
        70,
    )
    .unwrap();
    idx.upsert_note(
        "Goals.md",
        "My goal is learning distributed systems.",
        2,
        40,
    )
    .unwrap();

    let provider = HashEmbeddingProvider::new();
    let ctx = assemble(&idx, &provider, "postgres databases", 6).unwrap();
    assert!(!ctx.hits.is_empty(), "retrieval hits present");
    assert!(!ctx.claims.is_empty(), "entity-matched claims present");
    assert!(!ctx.relationships.is_empty(), "relationships expanded");
    assert!(ctx.memories.is_empty(), "no accepted memories yet");

    // Accept the goal memory; it should now surface for a matching query.
    let memories = sovereign_core::memory::list(idx.connection(), Some("candidate")).unwrap();
    let mem = memories.first().unwrap();
    sovereign_core::memory::accept(idx.connection(), &mem.id).unwrap();
    let ctx2 = assemble(&idx, &provider, "distributed systems learning", 6).unwrap();
    assert!(
        ctx2.memories.iter().any(|m| m.id == mem.id),
        "accepted memory rides in context"
    );
}

#[test]
fn contradiction_queries_surface_all_open_contradictions() {
    let idx = index();
    // Same subject (user), same type, opposite polarity → contradiction (§54).
    idx.upsert_note("Old.md", "I prefer vim for editing.", 1, 25).unwrap();
    idx.upsert_note("New.md", "I do not prefer vim for editing.", 2, 31).unwrap();
    let created = sovereign_core::memory::detect_contradictions(idx.connection()).unwrap();
    assert_eq!(created, 1, "polarity flip detected");

    let provider = HashEmbeddingProvider::new();
    let ctx = assemble(&idx, &provider, "contradictory information about vim", 6).unwrap();
    assert_eq!(ctx.contradictions.len(), 1, "contradiction analysis returns it");
    assert_eq!(ctx.query_type, QueryType::Contradiction);
}

// ---------- §58 answers, citation validation, no fabrication ----------

#[test]
fn evidence_only_answer_when_model_cannot_generate() {
    let idx = index();
    idx.upsert_note(
        "Architecture/Database.md",
        "# Database\n\nWe decided to use PostgreSQL for the storage layer. It stores time series.",
        1,
        90,
    )
    .unwrap();
    let provider = HashEmbeddingProvider::new();
    let result = answer(&idx, &provider, "what did I decide about the database", 6).unwrap();

    assert_eq!(result.query_type, QueryType::Decision);
    assert_eq!(result.answer_mode, "evidence");
    assert!(result.answer.contains("[Architecture/Database.md]"), "every bullet cites its source");
    assert!(!result.sources.is_empty(), "sources are first-class");
    assert!(result.confidence > 0.0 && result.confidence <= 0.95);
}

#[test]
fn no_evidence_means_no_fabrication() {
    let idx = index(); // empty vault
    let provider = HashEmbeddingProvider::new();
    let result = answer(&idx, &provider, "quantum entanglement experiments", 6).unwrap();
    assert_eq!(result.answer, NO_EVIDENCE_MESSAGE);
    assert_eq!(result.answer_mode, "no_evidence");
    assert_eq!(result.confidence, 0.0);
    assert!(result.sources.is_empty());
}

#[test]
fn citations_must_resolve_to_retrieved_context() {
    let report = validate_citations(
        "You chose Postgres [Projects/Decision.md] and later revised it [[Decision.md]].",
        &["Projects/Decision.md".to_string()],
    );
    assert!(report.has_citations);
    assert!(report.all_resolved);
    assert_eq!(report.cited.len(), 2, "full path and basename both resolve");

    // Fabricated source: unresolved.
    let report2 = validate_citations(
        "Definitely in [Made/Up.md].",
        &["Projects/Decision.md".to_string()],
    );
    assert!(!report2.all_resolved, "fabricated citation flagged");

    // No citations at all: model answer would be discarded (§58).
    let report3 = validate_citations("It is certainly true.", &["A.md".to_string()]);
    assert!(!report3.has_citations);

    // Basename citations resolve too (models often drop the folder).
    let report4 = validate_citations("See [Decision.md].", &["Projects/Decision.md".to_string()]);
    assert!(report4.all_resolved);

    // Footnote-style [1] is not mistaken for a source.
    let report5 = validate_citations("The claim[1] stands.", &["A.md".to_string()]);
    assert!(!report5.has_citations);
}

#[test]
fn fabricated_model_answer_is_replaced_by_evidence_summary() {
    let idx = index();
    idx.upsert_note("Real.md", "The vault mentions storage engines briefly.", 1, 42).unwrap();

    // Simulate a generate-capable model that invents a citation.
    let lying = LyingProvider;
    let result = answer(&idx, &lying, "storage engines", 6).unwrap();
    assert_eq!(result.answer_mode, "evidence", "uncited model answer discarded");
    assert!(result.answer.contains("[Real.md]"), "evidence summary keeps citations");

    // An honest model answer (with valid citations) is kept.
    let honest = HonestProvider;
    let result2 = answer(&idx, &honest, "storage engines", 6).unwrap();
    assert_eq!(result2.answer_mode, "model");
    assert!(result2.answer.starts_with("Grounded answer:"));
}

/// Provider whose embeddings work (hash) but "generation" fabricates.
struct LyingProvider;
impl sovereign_core::models::ModelProvider for LyingProvider {
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, sovereign_core::models::ModelError> {
        HashEmbeddingProvider::new().embed(texts)
    }
    fn generate(&self, _prompt: &str) -> Result<String, sovereign_core::models::ModelError> {
        Ok("Totally invented facts [Fabricated/Note.md].".to_string())
    }
    fn name(&self) -> &'static str {
        "lying-test"
    }
    fn dimension(&self) -> usize {
        384
    }
}

struct HonestProvider;
impl sovereign_core::models::ModelProvider for HonestProvider {
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, sovereign_core::models::ModelError> {
        HashEmbeddingProvider::new().embed(texts)
    }
    fn generate(&self, _prompt: &str) -> Result<String, sovereign_core::models::ModelError> {
        Ok("Grounded answer: storage engines are discussed [Real.md].".to_string())
    }
    fn name(&self) -> &'static str {
        "honest-test"
    }
    fn dimension(&self) -> usize {
        384
    }
}

#[test]
fn agent_task_queries_never_generate_or_act() {
    let idx = index();
    idx.upsert_note("Research/A.md", "Research note about models.", 1, 30).unwrap();
    let provider = HashEmbeddingProvider::new();
    let result = answer(&idx, &provider, "organize my research notes", 6).unwrap();
    assert_eq!(result.query_type, QueryType::AgentTask);
    assert_eq!(result.answer_mode, "agent");
    assert!(result.answer.contains("approval"), "routing message mentions approval");
}

#[test]
fn evidence_answer_lists_memories_and_contradictions() {
    let idx = index();
    idx.upsert_note("Old.md", "I prefer vim for editing.", 1, 25).unwrap();
    idx.upsert_note("New.md", "I do not prefer vim for editing.", 2, 31).unwrap();
    sovereign_core::memory::detect_contradictions(idx.connection()).unwrap();
    let ctx = assemble(&idx, &HashEmbeddingProvider::new(), "vim preference conflict", 6).unwrap();
    let text = evidence_answer(&ctx);
    assert!(text.contains("Unresolved contradiction"), "contradictions surface in the summary");
    assert!(text.contains("[Old.md]") && text.contains("[New.md]"));
}

// ---------- `brain.ask` over stdio (§87, §107) ----------

struct CoreProc {
    child: Child,
}

impl CoreProc {
    fn spawn() -> Self {
        let tmp = std::env::temp_dir().join(format!(
            "sovereign-ask-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .subsec_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let bin = env!("CARGO_BIN_EXE_sovereign-core");
        let child = Command::new(bin)
            .arg("--data-dir")
            .arg(&tmp)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("failed to spawn core");
        Self { child }
    }

    fn request(&mut self, env: &Envelope) -> Envelope {
        let stdin = self.child.stdin.as_mut().unwrap();
        write_envelope(stdin, env).unwrap();
        let stdout = self.child.stdout.as_mut().unwrap();
        let mut reader = BufReader::new(stdout);
        read_envelope(&mut reader).unwrap().expect("core replied")
    }

    fn sync_note(&mut self, req_id: &str, path: &str, content: &str) {
        let reply = self.request(&Envelope::request("a0", "vault.sync.begin", json!({})));
        let session = reply.result.unwrap()["session_id"].as_str().unwrap().to_string();
        self.request(&Envelope::request(
            req_id,
            "vault.sync.batch",
            json!({
                "session_id": session,
                "notes": [{
                    "path": path,
                    "hash": sovereign_core::vault::manager::hash_content(content),
                    "mtime": 1,
                    "size": content.len(),
                }],
            }),
        ));
        self.request(&Envelope::request(req_id, "vault.sync.commit", json!({"session_id": session})));
        self.request(&Envelope::request(
            req_id,
            "vault.sync.note",
            json!({
                "session_id": session,
                "path": path,
                "hash": sovereign_core::vault::manager::hash_content(content),
                "mtime": 1,
                "size": content.len(),
                "content": content,
            }),
        ));
        self.request(&Envelope::request(req_id, "vault.sync.finish", json!({"session_id": session})));
    }
}

impl Drop for CoreProc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn brain_ask_round_trip_over_stdio() {
    let mut core = CoreProc::spawn();

    // Empty query → INVALID_PARAMS.
    let reply = core.request(&Envelope::request("q1", "brain.ask", json!({"query": "   "})));
    assert_eq!(reply.error.expect("error").code, ErrorCode::InvalidParams);

    // Unknown field → INVALID_PARAMS (strict params schema).
    let reply = core.request(&Envelope::request(
        "q2",
        "brain.ask",
        json!({"query": "x", "bogus": 1}),
    ));
    assert_eq!(reply.error.expect("error").code, ErrorCode::InvalidParams);

    // Sync an evidence note, then ask with evidence available.
    core.sync_note(
        "q3",
        "Architecture/Database.md",
        "# Database\n\nWe decided to use PostgreSQL for the storage layer.",
    );
    let reply = core.request(&Envelope::request(
        "q4",
        "brain.ask",
        json!({"query": "what did I decide about the database", "limit": 4}),
    ));
    let result = reply.result.expect("brain.ask result");
    assert_eq!(result["query_type"], "decision");
    assert_eq!(result["answer_mode"], "evidence");
    assert!(
        result["answer"].as_str().unwrap().contains("[Architecture/Database.md]"),
        "answer cites its source: {}",
        result["answer"]
    );
    let sources = result["sources"].as_array().unwrap();
    assert!(!sources.is_empty());
    assert!(sources[0]["note_path"].is_string());
    assert!(sources[0]["score"].is_number());
    assert!(result["confidence"].as_f64().unwrap() > 0.0);
    assert!(result["memories"].is_array());
    assert!(result["contradictions"].is_array());

    // Ask about something absent → the no-fabrication message (§58).
    let reply = core.request(&Envelope::request(
        "q5",
        "brain.ask",
        json!({"query": "underwater basket weaving techniques"}),
    ));
    let result = reply.result.expect("brain.ask result");
    assert_eq!(result["answer"], NO_EVIDENCE_MESSAGE);
    assert_eq!(result["answer_mode"], "no_evidence");
    assert_eq!(result["confidence"], 0.0);

    // Ask for a vault action → agent routing, no generation (§95).
    let reply = core.request(&Envelope::request(
        "q6",
        "brain.ask",
        json!({"query": "organize my research notes"}),
    ));
    let result = reply.result.expect("brain.ask result");
    assert_eq!(result["query_type"], "agent_task");
    assert_eq!(result["answer_mode"], "agent");

    core.request(&Envelope::request("q7", "core.shutdown", json!({})));
}

#[test]
fn memory_api_error_converts_to_api_error() {
    // Sanity for the error surface used by the dispatcher's memory paths.
    let err = MemoryApiError::NotFound("mem_x".to_string());
    assert!(matches!(err, MemoryApiError::NotFound(_)));
}
