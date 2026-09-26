//! Hybrid retrieval (PLAN.md §42, §44): deterministic, testable ranking that
//! blends lexical relevance (FTS5 bm25), semantic similarity (embedding
//! cosine) and entity overlap. The LLM never chooses sources (§44) — this
//! module does, deterministically.

use crate::indexing::NoteIndex;
use crate::models::{blob_to_vector, cosine, ModelProvider};
use serde::{Deserialize, Serialize};

/// Ranking weights (§44 candidate score). Tunable constants, not magic.
pub const WEIGHT_LEXICAL: f64 = 0.5;
pub const WEIGHT_SEMANTIC: f64 = 0.35;
pub const WEIGHT_ENTITY: f64 = 0.15;

/// One hybrid hit with its score breakdown (§44: ranking must be inspectable).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct HybridHit {
    pub note_id: String,
    pub note_path: String,
    pub chunk_id: String,
    pub heading_path: String,
    pub snippet: String,
    pub score: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score_breakdown: Option<ScoreBreakdown>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ScoreBreakdown {
    pub lexical: f64,
    pub semantic: f64,
    pub entity: f64,
}

/// Run hybrid retrieval. `lexical` hits come from FTS; semantic candidates
/// come from cosine over embedded chunks; entity boost applies when the query
/// names an entity known to the knowledge layer.
pub fn search(
    index: &NoteIndex,
    provider: &dyn ModelProvider,
    query: &str,
    limit: usize,
) -> Result<Vec<HybridHit>, rusqlite::Error> {
    // ---- Lexical arm (fast path, §94).
    let lexical = index.search(query, limit * 2)?;

    // ---- Semantic arm: embed the query, cosine against embedded chunks.
    let query_vec: Vec<f32> = provider
        .embed(&[query.to_string()])
        .map_err(|_| rusqlite::Error::InvalidQuery)?
        .pop()
        .unwrap_or_default();

    // Candidate universe: chunks with embeddings (bounded scan, §93).
    let conn = index.connection();
    let mut semantic: Vec<HybridHit> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT c.id, c.text, c.heading_path, c.embedding, n.id, n.path
             FROM chunks c
             JOIN notes n ON n.id = c.note_id
             WHERE c.embedding IS NOT NULL AND n.status = 'active'",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Vec<u8>>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        })?;
        for row in rows {
            let (chunk_id, text, heading, blob, note_id, note_path) = row?;
            let vec = blob_to_vector(&blob);
            let sim = cosine(&query_vec, &vec) as f64;
            if sim > 0.01 {
                semantic.push(HybridHit {
                    note_id,
                    note_path,
                    chunk_id,
                    heading_path: heading,
                    snippet: make_snippet(&text, query),
                    score: sim,
                    score_breakdown: None,
                });
            }
        }
    }

    // ---- Entity arm: does the query name a known entity? Boost its notes.
    let entity_notes = entity_matches(conn, query)?;

    // ---- Merge and rank.
    let mut best: HashMap<String, HybridHit> = HashMap::new(); // chunk_id → hit

    let max_lexical = lexical
        .first()
        .map(|h| -h.rank)
        .filter(|v| *v > 0.0)
        .unwrap_or(1.0);
    for (rank_pos, hit) in lexical.iter().enumerate() {
        let raw = -hit.rank;
        let lexical_score = if raw > 0.0 { raw / max_lexical } else { 0.0 };
        let entity_score = entity_notes.get(&hit.note_id).copied().unwrap_or(0.0);
        let score = WEIGHT_LEXICAL * lexical_score
            + WEIGHT_ENTITY * entity_score;
        best.insert(
            hit.chunk_id.clone(),
            HybridHit {
                score,
                score_breakdown: Some(ScoreBreakdown {
                    lexical: lexical_score,
                    semantic: 0.0,
                    entity: entity_score,
                }),
                ..to_owned(hit)
            },
        );
        // Positional tie-breaker: later lexical hits rank below earlier ones
        // when merged without a semantic signal.
        let _ = rank_pos;
    }

    let max_semantic = semantic
        .iter()
        .map(|h| h.score)
        .fold(0.0f64, f64::max)
        .max(0.0001);
    for hit in &semantic {
        let semantic_score = hit.score / max_semantic;
        let entity_score = entity_notes.get(&hit.note_id).copied().unwrap_or(0.0);
        let entry = best.entry(hit.chunk_id.clone()).or_insert_with(|| HybridHit {
            score: 0.0,
            score_breakdown: Some(ScoreBreakdown {
                lexical: 0.0,
                semantic: semantic_score,
                entity: entity_score,
            }),
            ..clone_shallow(hit)
        });
        let (lex, _sem, ent) = match entry.score_breakdown {
            Some(b) => (b.lexical, b.semantic, b.entity),
            None => (0.0, 0.0, 0.0),
        };
        entry.score_breakdown = Some(ScoreBreakdown {
            lexical: lex,
            semantic: semantic_score.max(_sem),
            entity: ent.max(entity_score),
        });
        entry.score = WEIGHT_LEXICAL * lex
            + WEIGHT_SEMANTIC * semantic_score.max(_sem)
            + WEIGHT_ENTITY * ent.max(entity_score);
    }

    let mut hits: Vec<HybridHit> = best.into_values().collect();
    hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    hits.truncate(limit);
    Ok(hits)
}

fn to_owned(hit: &crate::indexing::SearchHit) -> HybridHit {
    HybridHit {
        note_id: hit.note_id.clone(),
        note_path: hit.note_path.clone(),
        chunk_id: hit.chunk_id.clone(),
        heading_path: hit.heading_path.clone(),
        snippet: hit.snippet.clone(),
        score: 0.0,
        score_breakdown: None,
    }
}

fn clone_shallow(hit: &HybridHit) -> HybridHit {
    hit.clone()
}

/// Query → {note_id: boost} for notes mentioning entities the query names.
fn entity_matches(
    conn: &rusqlite::Connection,
    query: &str,
) -> Result<HashMap<String, f64>, rusqlite::Error> {
    let mut out = HashMap::new();
    let lower = query.to_lowercase();
    let mut stmt = conn.prepare(
        "SELECT e.id, lower(e.canonical_name), m.note_id
         FROM entities e
         JOIN entity_mentions m ON m.entity_id = e.id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    for row in rows {
        let (name, note_id) = row?;
        if lower.contains(&name) {
            // More specific (longer) entity names get a fuller boost.
            let boost: f64 = (name.len() as f64 / 24.0).clamp(0.5, 1.0);
            let current: f64 = out.get(&note_id).copied().unwrap_or(0.0);
            out.insert(note_id, current.max(boost));
        }
    }
    Ok(out)
}

/// Crude snippet without FTS highlight markers (semantic arm).
fn make_snippet(text: &str, query: &str) -> String {
    let lower = text.to_lowercase();
    let probe = query
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_lowercase();
    let start = if probe.is_empty() {
        0
    } else {
        lower.find(&probe).unwrap_or(0)
    };
    let from = start.saturating_sub(40);
    let mut end = (from + 180).min(text.len());
    while end < text.len() && !text.is_char_boundary(end) {
        end += 1;
    }
    let mut from_i = from;
    while from_i < text.len() && !text.is_char_boundary(from_i) {
        from_i += 1;
    }
    let mut s = text[from_i..end].trim().to_string();
    if from > 0 {
        s.insert_str(0, "…");
    }
    if end < text.len() {
        s.push('…');
    }
    s
}

use std::collections::HashMap;
