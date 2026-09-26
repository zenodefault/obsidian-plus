//! Reasoning (PLAN.md §56–58, §95, §107): the deterministic pipeline that
//! turns a user question into an evidence-backed answer.
//!
//! Pipeline (§56): classify → retrieve → memory retrieval → relationship
//! expansion → context assembly → (local LLM) → citation validation → answer.
//!
//! Safety rules baked into this module:
//! - The LLM never chooses sources (§44) — retrieval is deterministic.
//! - A model answer that cites nothing, or cites notes outside the retrieved
//!   context, is discarded in favour of the deterministic evidence summary
//!   (§58: grounded claims must cite sources; never fabricate).
//! - With no generate-capable model (the default hash embedder, §76) the
//!   evidence summary IS the answer — the pipeline degrades, never lies.
//! - With no evidence at all the only honest answer is the §58 message.

use crate::indexing::NoteIndex;
use crate::memory::{self, ContradictionEntry, MemoryEntry};
use crate::models::ModelProvider;
use crate::retrieval::{self, HybridHit};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// The §58 no-fabrication answer, verbatim.
pub const NO_EVIDENCE_MESSAGE: &str = "I couldn't find evidence for this in the vault.";

/// `agent_task` queries never generate prose or act: changes only ever come
/// through the agent's preview + approval flow (§59–63, Part 8).
pub const AGENT_TASK_MESSAGE: &str = "This looks like a vault action rather than a question. \
Proposed changes always arrive as a preview requiring your explicit approval; \
nothing was modified.";

/// Default number of context chunks assembled for one question.
pub const DEFAULT_CONTEXT_LIMIT: usize = 6;
/// Hard clamp on `brain.ask` `limit` (bounded responses, §94).
pub const MAX_CONTEXT_LIMIT: usize = 20;

/// Query classification (§95). Deterministic keyword matching — simple
/// searches must not trigger expensive reasoning (§94).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueryType {
    SimpleSearch,
    SemanticSearch,
    Synthesis,
    Comparison,
    Temporal,
    Contradiction,
    Decision,
    Relationship,
    AgentTask,
}

/// Classify a natural-language query (§95). Order matters: the most specific
/// intent wins; anything unrecognised is a simple keyword lookup.
pub fn classify_query(query: &str) -> QueryType {
    let q = query.to_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| q.contains(n));

    // Agent tasks: vault mutations the user is asking for (handled by the
    // agent with approval, Part 8 — never by this pipeline).
    if has(&[
        "organize", "organise", "tidy", "clean up", "clean my", "rename ", "move my", "merge ",
        "sort my", "suggest links", "archive my", "restructure", "refactor my",
    ]) {
        return QueryType::AgentTask;
    }
    if has(&["contradict", "conflict", "inconsistent", "disagree"]) {
        return QueryType::Contradiction;
    }
    if has(&[
        "over time", "changed", "history of", "used to", "no longer", "evolution", "timeline",
        "how has my", "progress", "before and after",
    ]) {
        return QueryType::Temporal;
    }
    if has(&["compare", " vs ", "versus", "difference between", "better than", "which is better"]) {
        return QueryType::Comparison;
    }
    if has(&["decide", "decided", "decision", "chose", "chosen", "what did i choose", "did i pick"]) {
        return QueryType::Decision;
    }
    if has(&[
        "related", "connection", "connect", "linked", "relationship", "what links", "who works",
    ]) {
        return QueryType::Relationship;
    }
    if has(&[
        "summarize", "summarise", "summary", "what have i learned", "explain", "overview",
        "everything about", "across my", "how do i",
    ]) {
        return QueryType::Synthesis;
    }
    if has(&[
        "notes about", "similar to", "like this", "meaning of", "concept of", "find notes",
        "what is", "what are", "how does",
    ]) {
        return QueryType::SemanticSearch;
    }
    QueryType::SimpleSearch
}

// ---- Wire types (§87 example shape) ----

/// Params of `brain.ask`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, default)]
pub struct AskParams {
    pub query: String,
    /// Max context chunks (default 6, clamped to 1..=20).
    pub limit: Option<usize>,
}

/// One cited source of the answer (§58: sources are first-class and openable).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AskSource {
    pub note_id: String,
    pub note_path: String,
    pub chunk_id: String,
    pub heading_path: String,
    pub snippet: String,
    pub score: f64,
}

/// Result payload of `brain.ask` (§87: answer + sources + memories +
/// contradictions).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AskResult {
    pub answer: String,
    pub query_type: QueryType,
    /// 0.0 (no evidence) … 0.95; deterministic from retrieval scores.
    pub confidence: f64,
    /// How the answer was produced:
    /// - `model`: local LLM output, citations validated;
    /// - `evidence`: deterministic summary of retrieved context;
    /// - `agent`: vault-action routing message (no generation);
    /// - `no_evidence`: the §58 no-fabrication message.
    pub answer_mode: String,
    pub sources: Vec<AskSource>,
    pub memories: Vec<MemoryEntry>,
    pub contradictions: Vec<ContradictionEntry>,
}

// ---- Context assembly (§56) ----

/// A claim surfaced through entity matching (§56 relationship expansion).
#[derive(Debug, Clone, PartialEq)]
pub struct ContextClaim {
    pub subject: String,
    pub predicate: String,
    pub object: String,
    pub claim_type: String,
    pub polarity: i32,
    pub note_path: String,
}

/// Everything the answer may be grounded in (§56 pipeline minus the LLM).
#[derive(Debug, Clone, PartialEq)]
pub struct AssembledContext {
    pub query_type: QueryType,
    pub hits: Vec<HybridHit>,
    /// Accepted memories relevant to the query (§49: memory is user context).
    pub memories: Vec<MemoryEntry>,
    /// Claims mentioning entities named by the query.
    pub claims: Vec<ContextClaim>,
    /// Relationships (source name, type, target name) for those entities.
    pub relationships: Vec<(String, String, String)>,
    /// Open contradictions touching the query (all of them when the query is
    /// itself a contradiction analysis, §54: show both, never choose).
    pub contradictions: Vec<ContradictionEntry>,
}

impl AssembledContext {
    fn has_evidence(&self) -> bool {
        !self.hits.is_empty()
            || !self.memories.is_empty()
            || !self.claims.is_empty()
            || !self.contradictions.is_empty()
    }
}

/// Assemble the full reasoning context for a query.
pub fn assemble(
    index: &NoteIndex,
    provider: &dyn ModelProvider,
    query: &str,
    limit: usize,
) -> Result<AssembledContext, rusqlite::Error> {
    let query_type = classify_query(query);
    let hits = retrieve(index, provider, query, limit.clamp(1, MAX_CONTEXT_LIMIT));
    let conn = index.connection();
    let memories = relevant_memories(conn, query)?;
    let (claims, relationships) = knowledge_context(conn, query)?;
    let contradictions = relevant_contradictions(conn, query, query_type)?;
    Ok(AssembledContext {
        query_type,
        hits,
        memories,
        claims,
        relationships,
        contradictions,
    })
}

/// Answer a question end-to-end (§107: ask → classify → search → memories →
/// relationships → reason locally → validate evidence → answer + sources).
pub fn answer(
    index: &NoteIndex,
    provider: &dyn ModelProvider,
    query: &str,
    context_limit: usize,
) -> Result<AskResult, rusqlite::Error> {
    let ctx = assemble(index, provider, query, context_limit)?;
    let query_type = ctx.query_type;
    let sources: Vec<AskSource> = ctx.hits.iter().map(to_source).collect();
    let source_paths: Vec<String> = ctx.hits.iter().map(|h| h.note_path.clone()).collect();

    // Agent tasks never generate prose and never act (§59, §95).
    if query_type == QueryType::AgentTask {
        return Ok(AskResult {
            answer: AGENT_TASK_MESSAGE.to_string(),
            query_type,
            confidence: 0.3,
            answer_mode: "agent".to_string(),
            sources,
            memories: ctx.memories,
            contradictions: ctx.contradictions,
        });
    }

    if !ctx.has_evidence() {
        return Ok(AskResult {
            answer: NO_EVIDENCE_MESSAGE.to_string(),
            query_type,
            confidence: 0.0,
            answer_mode: "no_evidence".to_string(),
            sources,
            memories: Vec::new(),
            contradictions: Vec::new(),
        });
    }

    let evidence = evidence_answer(&ctx);
    let (answer, answer_mode) = match provider.generate(&build_prompt(query, &ctx)) {
        Ok(model_answer) => {
            // §58 citation validation: the model may only keep its answer when
            // it cites at least one source and every citation resolves to the
            // retrieved context. Otherwise fall back to the evidence summary.
            let report = validate_citations(&model_answer, &source_paths);
            if report.has_citations && report.all_resolved {
                (model_answer, "model")
            } else {
                (evidence, "evidence")
            }
        }
        Err(_) => (evidence, "evidence"),
    };

    Ok(AskResult {
        answer,
        query_type,
        confidence: confidence_for(&ctx.hits),
        answer_mode: answer_mode.to_string(),
        sources,
        memories: ctx.memories,
        contradictions: ctx.contradictions,
    })
}

/// Hybrid retrieval with lexical fallback (§76: a failing model must never
/// take the answer pipeline down).
fn retrieve(index: &NoteIndex, provider: &dyn ModelProvider, query: &str, limit: usize) -> Vec<HybridHit> {
    match retrieval::search(index, provider, query, limit) {
        Ok(hits) => hits,
        Err(_) => index
            .search(query, limit)
            .unwrap_or_default()
            .into_iter()
            .map(|h| HybridHit {
                note_id: h.note_id,
                note_path: h.note_path,
                chunk_id: h.chunk_id,
                heading_path: h.heading_path,
                snippet: h.snippet,
                score: -h.rank,
                score_breakdown: None,
            })
            .collect(),
    }
}

/// Accepted memories sharing query tokens (§49: memory ≠ retrieved text; the
/// user's accepted context rides alongside vault evidence).
fn relevant_memories(conn: &Connection, query: &str) -> Result<Vec<MemoryEntry>, rusqlite::Error> {
    let tokens = query_tokens(query);
    let all = memory::list(conn, Some("accepted"))?;
    let mut scored: Vec<(usize, MemoryEntry)> = all
        .into_iter()
        .map(|m| {
            let lower = m.content.to_lowercase();
            let score = tokens.iter().filter(|t| lower.contains(t.as_str())).count();
            (score, m)
        })
        .filter(|(score, _)| *score > 0)
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.updated_at.cmp(&a.1.updated_at)));
    Ok(scored
        .into_iter()
        .take(3)
        .map(|(_, m)| m)
        .collect())
}

/// Claims + relationships for entities the query names (§56 relationship
/// expansion). Bounded scans; deterministic newest-first ordering.
fn knowledge_context(
    conn: &Connection,
    query: &str,
) -> Result<(Vec<ContextClaim>, Vec<(String, String, String)>), rusqlite::Error> {
    let names = query_entity_names(conn, query)?;
    if names.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }

    let mut stmt = conn.prepare(
        "SELECT c.subject, c.predicate, c.object, c.claim_type, c.polarity, n.path
         FROM claims c
         JOIN notes n ON n.id = c.source_note_id
         WHERE c.status = 'active'
         ORDER BY c.rowid DESC
         LIMIT 400",
    )?;
    let claims: Vec<ContextClaim> = stmt
        .query_map([], |r| {
            Ok(ContextClaim {
                subject: r.get(0)?,
                predicate: r.get(1)?,
                object: r.get(2)?,
                claim_type: r.get(3)?,
                polarity: r.get(4)?,
                note_path: r.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|c| {
            let hay = format!("{} {} {}", c.subject, c.predicate, c.object).to_lowercase();
            names.iter().any(|n| hay.contains(n.as_str()))
        })
        .take(4)
        .collect();

    let mut stmt = conn.prepare(
        "SELECT se.canonical_name, r.relationship_type, te.canonical_name
         FROM relationships r
         JOIN entities se ON se.id = r.source_entity_id
         JOIN entities te ON te.id = r.target_entity_id
         WHERE r.status = 'active'
         ORDER BY r.rowid DESC
         LIMIT 400",
    )?;
    let relationships: Vec<(String, String, String)> = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|(s, _, t)| {
            names
                .iter()
                .any(|n| s.to_lowercase().contains(n.as_str()) || t.to_lowercase().contains(n.as_str()))
        })
        .take(6)
        .collect();

    Ok((claims, relationships))
}

/// Open contradictions touching the query; all of them for contradiction
/// analyses (§54: never silently choose one).
fn relevant_contradictions(
    conn: &Connection,
    query: &str,
    query_type: QueryType,
) -> Result<Vec<ContradictionEntry>, rusqlite::Error> {
    let all = memory::contradictions_list(conn)?;
    if query_type == QueryType::Contradiction {
        return Ok(all);
    }
    let tokens = query_tokens(query);
    Ok(all
        .into_iter()
        .filter(|c| {
            let a = format!(
                "{} {}",
                c.claim_a.object.to_lowercase(),
                c.claim_a.note_path.clone().unwrap_or_default().to_lowercase()
            );
            let b = format!(
                "{} {}",
                c.claim_b.object.to_lowercase(),
                c.claim_b.note_path.clone().unwrap_or_default().to_lowercase()
            );
            tokens
                .iter()
                .any(|t| a.contains(t.as_str()) || b.contains(t.as_str()))
        })
        .take(3)
        .collect())
}

/// Entities whose canonical name appears in the query (mirrors the retrieval
/// entity arm; names under 3 chars are noise).
fn query_entity_names(conn: &Connection, query: &str) -> Result<Vec<String>, rusqlite::Error> {
    let lower = query.to_lowercase();
    let mut stmt =
        conn.prepare("SELECT canonical_name FROM entities ORDER BY rowid LIMIT 500")?;
    let names: Vec<String> = stmt
        .query_map([], |r| r.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(names
        .into_iter()
        .filter(|n| {
            let ln = n.to_lowercase();
            ln.len() >= 3 && lower.contains(&ln)
        })
        .map(|n| n.to_lowercase())
        .take(25)
        .collect())
}

fn query_tokens(query: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in query.split_whitespace() {
        let cleaned: String = raw
            .chars()
            .map(|c| if c.is_ascii_punctuation() { ' ' } else { c })
            .collect();
        for piece in cleaned.split_whitespace() {
            let lower = piece.to_lowercase();
            if lower.len() >= 3 && !out.contains(&lower) {
                out.push(lower);
            }
        }
        if out.len() >= 24 {
            break;
        }
    }
    out
}

// ---- Answer generation (§58) ----

/// Deterministic evidence summary: every bullet cites its source note, so the
/// §58 citation requirement holds by construction.
pub fn evidence_answer(ctx: &AssembledContext) -> String {
    let mut out = String::from("Here is what your vault contains about this:");
    for h in &ctx.hits {
        out.push_str(&format!(
            "\n- {} [{}]",
            h.snippet.replace('\n', " ").trim(),
            h.note_path
        ));
    }
    for m in &ctx.memories {
        let path = m
            .sources
            .iter()
            .find_map(|s| s.note_path.clone())
            .unwrap_or_else(|| "unknown".to_string());
        out.push_str(&format!("\n- Memory: “{}” [{}]", m.content, path));
    }
    for c in &ctx.claims {
        out.push_str(&format!("\n- “{}” [{}]", c.object, c.note_path));
    }
    for c in &ctx.contradictions {
        out.push_str(&format!(
            "\n- Unresolved contradiction: “{}” [{}] vs “{}” [{}]",
            c.claim_a.object,
            c.claim_a.note_path.clone().unwrap_or_else(|| "unknown".into()),
            c.claim_b.object,
            c.claim_b.note_path.clone().unwrap_or_else(|| "unknown".into()),
        ));
    }
    out
}

/// Grounded generation prompt (§67: retrieved content is data, rules live in
/// the system framing — and permissions are enforced outside the model).
fn build_prompt(query: &str, ctx: &AssembledContext) -> String {
    let mut p = String::new();
    p.push_str("You are the user's local Sovereign Brain. Answer strictly from the evidence below.\n");
    p.push_str("Rules:\n");
    p.push_str("- Use only the evidence; never invent facts.\n");
    p.push_str("- Cite the note path in square brackets after each statement, e.g. [Projects/Decisions.md].\n");
    p.push_str("- If the evidence does not answer the question, reply exactly: I couldn't find evidence for this in the vault.\n\n");
    p.push_str(&format!("Question: {}\n\nEvidence:\n", query));
    for h in &ctx.hits {
        p.push_str(&format!("\n[{}]\n{}\n", h.note_path, h.snippet.replace('\n', " ").trim()));
    }
    for m in &ctx.memories {
        let path = m
            .sources
            .iter()
            .find_map(|s| s.note_path.clone())
            .unwrap_or_else(|| "unknown".to_string());
        p.push_str(&format!("\n[{}]\nUser memory: {}\n", path, m.content));
    }
    for c in &ctx.claims {
        p.push_str(&format!("\n[{}]\nClaim: {} {} {}\n", c.note_path, c.subject, c.predicate, c.object));
    }
    for c in &ctx.contradictions {
        p.push_str(&format!(
            "\n[{}]\nOpen contradiction with [{}]: “{}” vs “{}”\n",
            c.claim_a.note_path.clone().unwrap_or_else(|| "unknown".into()),
            c.claim_b.note_path.clone().unwrap_or_else(|| "unknown".into()),
            c.claim_a.object,
            c.claim_b.object,
        ));
    }
    p.push_str("\nAnswer:");
    p
}

/// Deterministic confidence from retrieval quality and evidence volume.
fn confidence_for(hits: &[HybridHit]) -> f64 {
    let top = hits.first().map(|h| h.score).unwrap_or(0.0).clamp(0.0, 1.0);
    (0.35 + 0.08 * hits.len().min(5) as f64 + 0.35 * top).min(0.95)
}

fn to_source(h: &HybridHit) -> AskSource {
    AskSource {
        note_id: h.note_id.clone(),
        note_path: h.note_path.clone(),
        chunk_id: h.chunk_id.clone(),
        heading_path: h.heading_path.clone(),
        snippet: h.snippet.clone(),
        score: h.score,
    }
}

// ---- Citation validation (§58) ----

/// Outcome of validating an answer's citations against the retrieved context.
#[derive(Debug, Clone, PartialEq)]
pub struct CitationReport {
    /// Citations that resolved to a known source path.
    pub cited: Vec<String>,
    /// Citations pointing outside the retrieved context (fabrication signal).
    pub unresolved: Vec<String>,
    pub has_citations: bool,
    pub all_resolved: bool,
}

/// Validate an answer's citations. Recognises `[Path/Note.md]` bare refs,
/// `[[Wikilinks]]` and `[text](markdown targets)`. Full paths and basenames
/// both resolve (models often drop the folder; the note is still the source).
pub fn validate_citations(answer: &str, source_paths: &[String]) -> CitationReport {
    let full: HashSet<String> = source_paths.iter().map(|p| p.to_lowercase()).collect();
    let bases: HashSet<String> = source_paths
        .iter()
        .map(|p| basename(p).to_lowercase())
        .collect();
    let stems: HashSet<String> = bases
        .iter()
        .map(|b| b.strip_suffix(".md").unwrap_or(b).to_string())
        .collect();

    let mut cited: Vec<String> = Vec::new();
    let mut unresolved: Vec<String> = Vec::new();
    for citation in extract_citations(answer) {
        let key = citation.trim().trim_end_matches('/').to_lowercase();
        let stem = key.strip_suffix(".md").unwrap_or(&key).to_string();
        if full.contains(&key)
            || bases.contains(&key)
            || stems.contains(&stem)
            || full.contains(&stem)
        {
            if !cited.iter().any(|c| c.eq_ignore_ascii_case(&citation)) {
                cited.push(citation);
            }
        } else {
            unresolved.push(citation);
        }
    }
    CitationReport {
        has_citations: !cited.is_empty(),
        all_resolved: unresolved.is_empty(),
        cited,
        unresolved,
    }
}

/// Extract citation candidates from an answer. Bare `[...]` groups only count
/// when they look like a path (contains `/` or ends in `.md`) so footnotes
/// like `[1]` are not mistaken for sources.
fn extract_citations(answer: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let bytes = answer.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'[' {
            i += 1;
            continue;
        }
        // Wikilink [[target]].
        if bytes.get(i + 1) == Some(&b'[') {
            if let Some(end) = answer[i + 2..].find("]]") {
                let inner = answer[i + 2..i + 2 + end].trim();
                if !inner.is_empty() {
                    out.push(inner.to_string());
                }
                i = i + 2 + end + 2;
                continue;
            }
        }
        let Some(close_rel) = answer[i + 1..].find(']') else {
            i += 1;
            continue;
        };
        let close = i + 1 + close_rel;
        let inner = &answer[i + 1..close];
        // Markdown link [text](target).
        if let Some(after) = answer[close + 1..].strip_prefix('(') {
            if let Some(rp) = after.find(')') {
                let target = after[..rp].trim();
                if !target.is_empty() {
                    out.push(target.to_string());
                }
                i = close + rp + 2;
                continue;
            }
        }
        // Bare [reference].
        let trimmed = inner.trim();
        if !trimmed.is_empty() && (trimmed.contains('/') || trimmed.to_lowercase().ends_with(".md"))
        {
            out.push(trimmed.to_string());
        }
        i = close + 1;
    }
    out
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}
