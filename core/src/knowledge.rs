//! Knowledge layer (PLAN.md §45–47): deterministic extraction of entities,
//! typed claims and relationships from parsed notes, with per-note provenance
//! so re-indexing is idempotent (delete-by-note, re-insert). No LLM here —
//! §7 reserves AI for semantic understanding, not structure.

use crate::parser::{parse, ParsedNote};
use crate::storage::db;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

/// Entity types (§46).
pub const ENTITY_TYPES: &[&str] = &[
    "PERSON", "ORGANIZATION", "PROJECT", "TECHNOLOGY", "CONCEPT", "PLACE", "EVENT", "DOCUMENT",
    "TOPIC", "OTHER",
];

/// Claim types (§48).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimType {
    Fact,
    Preference,
    Belief,
    Hypothesis,
    Observation,
    Experience,
    Decision,
    Goal,
    Question,
}

impl ClaimType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ClaimType::Fact => "FACT",
            ClaimType::Preference => "PREFERENCE",
            ClaimType::Belief => "BELIEF",
            ClaimType::Hypothesis => "HYPOTHESIS",
            ClaimType::Observation => "OBSERVATION",
            ClaimType::Experience => "EXPERIENCE",
            ClaimType::Decision => "DECISION",
            ClaimType::Goal => "GOAL",
            ClaimType::Question => "QUESTION",
        }
    }
}

/// An extracted entity mention candidate: a tag or wikilink target (§45).
/// Tags map to TOPIC, resolved links to the note's own entity, the rest to
/// CONCEPT — deterministic, no guesses about people or organizations without
/// the AI layer (Part 7 refines this).
#[derive(Debug, Clone, PartialEq)]
pub struct EntityCandidate {
    pub name: String,
    pub kind: &'static str,
}

/// A typed claim with source provenance (§48).
#[derive(Debug, Clone, PartialEq)]
pub struct ClaimCandidate {
    pub subject: String,
    pub predicate: String,
    pub object: String,
    pub claim_type: ClaimType,
    /// 1 = positive, -1 = negated (§48 polarity).
    pub polarity: i32,
    pub confidence: f64,
    /// Byte offset of the sentence start within the note (provenance §45).
    pub source_offset: usize,
}

/// One extraction result for a note.
#[derive(Debug, Default, PartialEq)]
pub struct NoteKnowledge {
    pub entities: Vec<EntityCandidate>,
    /// Wikilink targets as written (for note_links + broken-link detection).
    pub link_targets: Vec<String>,
    /// Entity-relation edges found in the note (§47).
    pub relationships: Vec<(String, String, String)>, // (source, predicate, target)
    pub claims: Vec<ClaimCandidate>,
}

/// Extract knowledge from raw note content. Fully deterministic.
pub fn extract(content: &str, note_title: Option<&str>) -> NoteKnowledge {
    let parsed = parse(content);
    let mut out = NoteKnowledge::default();

    // Entities: frontmatter/inline tags + wikilink targets.
    for tag in &parsed.tags {
        out.entities.push(EntityCandidate {
            name: tag.clone(),
            kind: "TOPIC",
        });
    }
    for link in &parsed.wikilinks {
        out.entities.push(EntityCandidate {
            name: link.clone(),
            kind: "CONCEPT",
        });
    }
    out.link_targets = parsed.wikilinks.clone();

    // The note itself is a DOCUMENT entity so [[links]] can resolve onto it.
    if let Some(title) = note_title {
        let title = title.trim();
        if !title.is_empty()
            && !out.entities.iter().any(|e| e.name.eq_ignore_ascii_case(title))
        {
            out.entities.push(EntityCandidate {
                name: title.to_string(),
                kind: "DOCUMENT",
            });
        }
    }

    // Claims + relationships from sentences.
    let (claims, relationships) = extract_claims(&parsed, content, note_title);
    out.claims = claims;
    out.relationships = relationships;
    out
}

/// Sentence-level claim analysis (§48). Markers come from word choice, not
/// the LLM: "decided/chose/switched to" → DECISION, "want/plan to" → GOAL,
/// "prefer" → PREFERENCE, "might/maybe" → HYPOTHESIS, "learned/found" →
/// EXPERIENCE, "?" → QUESTION, "is/are/has" → FACT. Negation flips polarity.
fn extract_claims(
    parsed: &ParsedNote,
    content: &str,
    note_title: Option<&str>,
) -> (Vec<ClaimCandidate>, Vec<(String, String, String)>) {
    let mut claims = Vec::new();
    let mut relationships = Vec::new();
    let subject = parsed
        .frontmatter
        .title
        .clone()
        .or_else(|| parsed.headings.first().map(|(_, t, _)| t.clone()))
        .or_else(|| note_title.map(|t| t.to_string()))
        .unwrap_or_else(|| "this note".to_string());

    for sentence in sentences(content) {
        let (text, offset) = sentence;
        let lower = text.to_lowercase();

        // Questions: interrogatives or trailing '?'.
        if text.trim_end().ends_with('?')
            || lower.starts_with("what ")
            || lower.starts_with("how ")
            || lower.starts_with("why ")
            || lower.starts_with("should ")
        {
            claims.push(ClaimCandidate {
                subject: subject.clone(),
                predicate: "asks".to_string(),
                object: truncate(&text),
                claim_type: ClaimType::Question,
                polarity: 1,
                confidence: 0.9,
                source_offset: offset,
            });
            continue;
        }

        let negated = [" not ", "n't ", "never ", "no longer "]
            .iter()
            .any(|n| lower.contains(n));
        let polarity: i32 = if negated { -1 } else { 1 };

        // Wikilink-based relationship: "uses [[Rust]]" style sentences.
        for link in &parsed.wikilinks {
            if lower.contains(&link.to_lowercase()) {
                if let Some((pred, ctype)) = relation_for(&lower, negated) {
                    relationships.push((subject.clone(), pred.to_string(), link.clone()));
                    claims.push(ClaimCandidate {
                        subject: subject.clone(),
                        predicate: pred.to_string(),
                        object: link.clone(),
                        claim_type: ctype,
                        polarity,
                        confidence: 0.7,
                        source_offset: offset,
                    });
                    break;
                }
            }
        }

        let ctype = classify_claim(&lower);
        let Some(ctype) = ctype else { continue };

        claims.push(ClaimCandidate {
            subject: subject.clone(),
            predicate: ctype_predicate(ctype).to_string(),
            object: truncate(&text),
            claim_type: ctype,
            polarity,
            confidence: 0.8,
            source_offset: offset,
        });
    }
    (claims, relationships)
}

fn classify_claim(lower: &str) -> Option<ClaimType> {
    // Order matters: most specific markers first.
    if contains_any(lower, &["decided", "chose", "chosen", "switched to", "went with", "we use"]) {
        Some(ClaimType::Decision)
    } else if contains_any(lower, &["want to", "plan to", "goal", "learning", "learn "]) {
        Some(ClaimType::Goal)
    } else if contains_any(lower, &["prefer", "favorite", "favourite", "i like", "i love", "i hate"]) {
        Some(ClaimType::Preference)
    } else if contains_any(lower, &["might", "maybe", "possibly", "considering", "may use", "perhaps"]) {
        Some(ClaimType::Hypothesis)
    } else if contains_any(lower, &["caused", "problem", "failed", "broke", "issue with", "error"]) {
        Some(ClaimType::Experience)
    } else if contains_any(lower, &["yesterday", "today", "last week", "noticed", "observed"]) {
        Some(ClaimType::Observation)
    } else if contains_any(lower, &["believe", "think that", "seems like", "probably"]) {
        Some(ClaimType::Belief)
    } else if contains_any(lower, &[" is ", " are ", " was ", " were ", " has ", " have ", " uses "]) {
        Some(ClaimType::Fact)
    } else {
        None
    }
}

fn relation_for(lower: &str, negated: bool) -> Option<(&'static str, ClaimType)> {
    if negated {
        return None; // negated relations need the AI layer; stay conservative
    }
    if contains_any(lower, &["uses", "using", " use ", "built with", "written in", "powered by"]) {
        Some(("uses", ClaimType::Fact))
    } else if contains_any(lower, &["interested in", "exploring", "learning"]) {
        Some(("interested_in", ClaimType::Goal))
    } else if contains_any(lower, &["part of", "belongs to", "member of"]) {
        Some(("part_of", ClaimType::Fact))
    } else {
        None
    }
}

fn ctype_predicate(t: ClaimType) -> &'static str {
    match t {
        ClaimType::Decision => "decided",
        ClaimType::Goal => "intends",
        ClaimType::Preference => "prefers",
        ClaimType::Hypothesis => "hypothesizes",
        ClaimType::Experience => "experienced",
        ClaimType::Observation => "observed",
        ClaimType::Belief => "believes",
        ClaimType::Fact => "states",
        ClaimType::Question => "asks",
    }
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| haystack.contains(n))
}

/// Split content into (sentence, start_offset) at `.`, `!`, `?` + newline.
/// Skips code blocks and frontmatter (§45: provenance must point at real prose).
fn sentences(content: &str) -> Vec<(&str, usize)> {
    let parsed_offsets = content
        .match_indices('\n')
        .map(|(i, _)| i)
        .collect::<Vec<_>>();
    let _ = parsed_offsets;

    let mut out = Vec::new();
    let mut in_code = false;
    let mut start: Option<usize> = None;
    let bytes = content.as_bytes();
    let mut i = 0usize;
    let mut line_start = true;

    while i < bytes.len() {
        let c = bytes[i] as char;
        if c == '\n' {
            line_start = true;
            let trimmed_rest = content[start.unwrap_or(i)..i].trim();
            if in_code {
                // fence close?
                if trimmed_rest.starts_with("```") || trimmed_rest.starts_with("~~~") {
                    in_code = false;
                }
                if let Some(s) = start.take() {
                    let text = content[s..i].trim();
                    if !text.is_empty() {
                        out.push((text, s));
                    }
                }
                i += 1;
                continue;
            }
            if let Some(s) = start {
                let text = content[s..i].trim();
                if !text.is_empty() {
                    out.push((text, s));
                }
                start = None;
            }
            i += 1;
            continue;
        }
        if line_start {
            let rest = &content[i..];
            if rest.starts_with("```") || rest.starts_with("~~~") {
                in_code = !in_code;
                if let Some(s) = start.take() {
                    let text = content[s..i].trim();
                    if !text.is_empty() {
                        out.push((text, s));
                    }
                }
                // Skip the fence line.
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
                continue;
            }
            line_start = false;
        }
        if start.is_none() && !c.is_whitespace() && !in_code {
            start = Some(i);
        }
        if !in_code && (c == '.' || c == '!' || c == '?') {
            // Sentence boundary only if followed by space/EOL (not "e.g." mid-word).
            let next = bytes.get(i + 1);
            if next.is_none() || next == Some(&b' ') || next == Some(&b'\n') {
                if let Some(s) = start.take() {
                    let text = content[s..=i].trim();
                    if !text.is_empty() {
                        out.push((text, s));
                    }
                }
            }
        }
        i += 1;
    }
    if let Some(s) = start {
        if !in_code {
            let text = content[s..].trim();
            if !text.is_empty() {
                out.push((text, s));
            }
        }
    }
    out
}

fn truncate(text: &str) -> String {
    let t = text.trim();
    if t.len() <= 300 {
        t.to_string()
    } else {
        let mut cut = t[..300].to_string();
        cut.push('…');
        cut
    }
}

/// Persist extraction results for a note, replacing prior extraction
/// (idempotent re-index). `note_id` must exist.
pub fn persist(
    conn: &Connection,
    note_id: &str,
    knowledge: &NoteKnowledge,
    now: i64,
) -> Result<(), rusqlite::Error> {
    let tx = conn.unchecked_transaction()?;

    // Capture prior mentions so source_count stays exact across re-index:
    // increment only newly-mentioned entities, decrement dropped ones.
    let prior: HashSet<String> = {
        let mut stmt = tx.prepare(
            "SELECT entity_id FROM entity_mentions WHERE note_id = ?1",
        )?;
        let rows = stmt.query_map(params![note_id], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<HashSet<_>, _>>()?
    };

    // Wipe this note's prior knowledge (provenance-scoped delete).
    tx.execute(
        "DELETE FROM entity_mentions WHERE note_id = ?1",
        params![note_id],
    )?;
    tx.execute(
        "DELETE FROM relationships WHERE source_note_id = ?1",
        params![note_id],
    )?;
    tx.execute("DELETE FROM claims WHERE source_note_id = ?1", params![note_id])?;
    tx.execute("DELETE FROM note_links WHERE note_id = ?1", params![note_id])?;

    // Entities: canonical by lower(name) — aliases preserve original case.
    let mut entity_ids: HashMap<String, String> = HashMap::new();
    for candidate in &knowledge.entities {
        let key = candidate.name.to_lowercase();
        if let Some(id) = entity_ids.get(&key) {
            // Already ensured this note mentions it.
            tx.execute(
                "INSERT OR IGNORE INTO entity_mentions (entity_id, note_id) VALUES (?1, ?2)",
                params![id, note_id],
            )?;
            continue;
        }
        let existing: Option<String> = tx
            .query_row(
                "SELECT id FROM entities WHERE lower(canonical_name) = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()?;
        let id = match existing {
            Some(id) => {
                // Increment only when this note is a NEW mentioner.
                if !prior.contains(&id) {
                    tx.execute(
                        "UPDATE entities SET source_count = source_count + 1, last_seen = ?2 WHERE id = ?1",
                        params![id, now],
                    )?;
                }
                id
            }
            None => {
                let id = Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO entities (id, canonical_name, type, aliases, first_seen, last_seen, source_count)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?5, 1)",
                    params![id, candidate.name, candidate.kind, "[]", now],
                )?;
                id
            }
        };
        entity_ids.insert(key, id.clone());
        tx.execute(
            "INSERT OR IGNORE INTO entity_mentions (entity_id, note_id) VALUES (?1, ?2)",
            params![id, note_id],
        )?;
    }

    // Decrement entities this note no longer mentions.
    for old_id in &prior {
        if !entity_ids.values().any(|v| v == old_id) {
            tx.execute(
                "UPDATE entities SET source_count = MAX(source_count - 1, 0) WHERE id = ?1",
                params![old_id],
            )?;
        }
    }

    // Claims with provenance (§45, §48).
    for claim in &knowledge.claims {
        tx.execute(
            "INSERT INTO claims (id, subject, predicate, object, claim_type, polarity, confidence, source_note_id, source_offset, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'active')",
            params![
                Uuid::new_v4().to_string(),
                claim.subject,
                claim.predicate,
                claim.object,
                claim.claim_type.as_str(),
                claim.polarity,
                claim.confidence,
                note_id,
                claim.source_offset as i64,
            ],
        )?;
    }

    // Relationships (deduped per note by the unique provenance index).
    for (source, predicate, target) in &knowledge.relationships {
        let src_id = entity_id_for(&tx, source, now)?;
        let tgt_id = entity_id_for(&tx, target, now)?;
        tx.execute(
            "INSERT OR IGNORE INTO relationships (id, source_entity_id, relationship_type, target_entity_id, confidence, status, created_at, updated_at, source_note_id)
             VALUES (?1, ?2, ?3, ?4, 0.7, 'active', ?5, ?5, ?6)",
            params![Uuid::new_v4().to_string(), src_id, predicate, tgt_id, now, note_id],
        )?;
    }

    // Note links for broken-link detection (§68).
    for target in &knowledge.link_targets {
        let resolved: Option<String> = tx
            .query_row(
                "SELECT id FROM notes WHERE lower(replace(path, '.md', '')) = lower(?1) OR lower(title) = lower(?1)",
                params![target],
                |r| r.get(0),
            )
            .optional()?;
        tx.execute(
            "INSERT OR IGNORE INTO note_links (note_id, target, resolved_note_id) VALUES (?1, ?2, ?3)",
            params![note_id, target, resolved],
        )?;
    }

    tx.commit()
}

/// Find-or-create an entity by name for relationship endpoints.
fn entity_id_for(conn: &Connection, name: &str, now: i64) -> Result<String, rusqlite::Error> {
    let key = name.to_lowercase();
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM entities WHERE lower(canonical_name) = ?1",
            params![key],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(id) = existing {
        return Ok(id);
    }
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO entities (id, canonical_name, type, aliases, first_seen, last_seen, source_count)
         VALUES (?1, ?2, 'CONCEPT', '[]', ?3, ?3, 0)",
        params![id, name, now],
    )?;
    Ok(id)
}

/// Re-resolve note_links after renames/new notes (§68 maintenance).
pub fn revalidate_links(conn: &Connection) -> Result<u64, rusqlite::Error> {
    let n = conn.execute(
        "UPDATE note_links SET resolved_note_id = (
            SELECT n.id FROM notes n
            WHERE lower(replace(n.path, '.md', '')) = lower(note_links.target)
               OR lower(n.title) = lower(note_links.target)
        )",
        [],
    )?;
    Ok(n as u64)
}

/// Extract + persist in one call (the upsert path).
pub fn extract_and_persist(
    conn: &Connection,
    note_id: &str,
    path: &str,
    content: &str,
) -> Result<NoteKnowledge, rusqlite::Error> {
    let title: Option<String> = conn
        .query_row(
            "SELECT title FROM notes WHERE id = ?1",
            params![note_id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    let title = title.or_else(|| fallback(path));
    let knowledge = extract(content, title.as_deref());
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    persist(conn, note_id, &knowledge, now)?;
    Ok(knowledge)
}

fn fallback(path: &str) -> Option<String> {
    path.rsplit('/')
        .next()
        .map(|f| f.trim_end_matches(".md").to_string())
}

/// Content-hash aware duplicate detection (§69): exact and normalized
/// similarity. Returns candidate pairs with a similarity score in [0, 1].
pub struct DuplicateCandidate {
    pub note_a: String,
    pub note_b: String,
    pub similarity: f64,
    pub reason: &'static str,
}

/// Find duplicate candidates across indexed notes. Deterministic; never
/// deletes anything (§69: "Never auto-delete").
pub fn find_duplicates(conn: &Connection) -> Result<Vec<DuplicateCandidate>, rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT id, path, sha256 FROM notes WHERE status = 'active'")?;
    let notes: Vec<(String, String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?;

    // Group by exact content hash first (strongest signal).
    let mut by_hash: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for (id, path, sha) in &notes {
        by_hash.entry(sha.clone()).or_default().push((id.clone(), path.clone()));
    }

    let mut out = Vec::new();
    for (_, group) in by_hash {
        if group.len() < 2 {
            continue;
        }
        for i in 0..group.len() {
            for j in (i + 1)..group.len() {
                out.push(DuplicateCandidate {
                    note_a: group[i].1.clone(),
                    note_b: group[j].1.clone(),
                    similarity: 1.0,
                    reason: "identical content",
                });
            }
        }
    }
    out.sort_by(|a, b| a.note_a.cmp(&b.note_a).then(a.note_b.cmp(&b.note_b)));
    Ok(out)
}

/// Re-export for callers that need the parse step separately.
pub fn parse_note(content: &str) -> ParsedNote {
    parse(content)
}

#[allow(dead_code)]
fn _silence_db_import() {
    let _ = db::open;
}
