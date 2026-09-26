//! Heading-aware chunking (PLAN.md §41): notes are split into paragraph
//! groups under their heading path, targeting 300–500 tokens with ~10%
//! overlap when a paragraph must be split. Code blocks are never split
//! unnecessarily; every chunk keeps its source offsets.

use crate::parser::{parse, BlockKind};

/// Chunking tunables (§41: 300–500 tokens target, ~10% overlap).
pub const TARGET_TOKENS: usize = 400;
pub const MIN_TOKENS: usize = 300;
pub const MAX_TOKENS: usize = 500;
pub const OVERLAP_RATIO: f64 = 0.10;

/// One produced chunk with its identity and provenance (§41, §80).
#[derive(Debug, Clone, PartialEq)]
pub struct Chunk {
    /// 0-based position within the note.
    pub ordinal: usize,
    /// Headings from the note root, e.g. `Setup > Database > Indexing`.
    pub heading_path: String,
    pub text: String,
    pub start_offset: usize,
    pub end_offset: usize,
    /// Cheap token estimate: words + punctuation clusters (§80).
    pub token_estimate: usize,
}

/// Chunk a parsed note. `content` is the full document; offsets are absolute.
pub fn chunk(content: &str) -> Vec<Chunk> {
    let parsed = parse(content);
    let mut chunks: Vec<Chunk> = Vec::new();

    // Heading path stack: (level, text).
    let mut stack: Vec<(u8, String)> = Vec::new();

    // Group blocks into paragraph groups bounded by headings; code blocks
    // become their own group so they are never split (§41).
    let mut groups: Vec<(String, Vec<(String, usize, usize)>)> = Vec::new();
    let mut current_heading = String::new();
    let mut current_group: Vec<(String, usize, usize)> = Vec::new();

    let flush_group = |groups: &mut Vec<(String, Vec<(String, usize, usize)>)>,
                       heading: &str,
                       group: &mut Vec<(String, usize, usize)>| {
        if !group.is_empty() {
            let text = group.iter().map(|(t, _, _)| t.as_str()).collect::<Vec<_>>().join("\n\n");
            let start = group.first().map(|(_, s, _)| *s).unwrap_or(0);
            let end = group.last().map(|(_, _, e)| *e).unwrap_or(0);
            groups.push((heading.to_string(), vec![(text, start, end)]));
            group.clear();
        }
    };

    for block in &parsed.blocks {
        match block.kind {
            BlockKind::Heading => {
                flush_group(&mut groups, &current_heading, &mut current_group);
                // Maintain the heading stack for the path string.
                while stack.last().is_some_and(|(lvl, _)| *lvl >= block.level) {
                    stack.pop();
                }
                let text = block.text.trim_start_matches('#').trim().to_string();
                stack.push((block.level, text.clone()));
                current_heading = stack
                    .iter()
                    .map(|(_, t)| t.as_str())
                    .collect::<Vec<_>>()
                    .join(" > ");
            }
            BlockKind::CodeBlock => {
                // A code block is emitted alone: never merged, never split.
                flush_group(&mut groups, &current_heading, &mut current_group);
                groups.push((
                    current_heading.clone(),
                    vec![(block.text.clone(), block.start_offset, block.end_offset)],
                ));
            }
            BlockKind::Paragraph | BlockKind::List | BlockKind::Blockquote => {
                current_group.push((
                    block.text.clone(),
                    block.start_offset,
                    block.end_offset,
                ));
                // Close the group when it reaches the token target.
                let tokens: usize = current_group
                    .iter()
                    .map(|(t, _, _)| estimate_tokens(t))
                    .sum();
                if tokens >= TARGET_TOKENS {
                    flush_group(&mut groups, &current_heading, &mut current_group);
                }
            }
        }
    }
    flush_group(&mut groups, &current_heading, &mut current_group);

    // Emit chunks, splitting oversized groups with overlap.
    let mut ordinal = 0;
    for (heading, parts) in groups {
        for (text, start, end) in parts {
            let tokens = estimate_tokens(&text);
            if tokens <= MAX_TOKENS {
                chunks.push(Chunk {
                    ordinal,
                    heading_path: heading.clone(),
                    text,
                    start_offset: start,
                    end_offset: end,
                    token_estimate: tokens,
                });
                ordinal += 1;
                continue;
            }
            // Oversized: split on paragraph/sentence boundaries with overlap.
            for (part, p_start, p_end) in split_oversized(&text, start) {
                let tokens = estimate_tokens(&part);
                chunks.push(Chunk {
                    ordinal,
                    heading_path: heading.clone(),
                    text: part,
                    start_offset: p_start,
                    end_offset: p_end,
                    token_estimate: tokens,
                });
                ordinal += 1;
            }
            let _ = end;
        }
    }
    chunks
}

/// Split `text` into ≤MAX_TOKEN pieces at line/sentence boundaries, carrying
/// ~10% overlap from the previous piece (§41).
fn split_oversized(text: &str, base_offset: usize) -> Vec<(String, usize, usize)> {
    let mut pieces: Vec<(String, usize, usize)> = Vec::new();
    let units: Vec<&str> = text.split('\n').collect();
    let mut current: Vec<&str> = Vec::new();
    let mut current_tokens = 0usize;
    let mut current_start = base_offset;
    let mut cursor = base_offset;

    let flush = |pieces: &mut Vec<(String, usize, usize)>,
                 current: &mut Vec<&str>,
                 tokens: &mut usize,
                 start: usize,
                 cursor: &mut usize| {
        if current.is_empty() {
            return;
        }
        let joined = current.join("\n");
        // Overlap: last ~10% of units re-opens the next piece.
        let overlap_units = ((current.len() as f64 * OVERLAP_RATIO).ceil() as usize).min(current.len() - 1);
        let overlap: Vec<&str> = current[current.len() - overlap_units..].to_vec();
        pieces.push((joined, start, *cursor));
        *tokens = overlap.iter().map(|u| estimate_tokens(u)).sum();
        current.clear();
        current.extend(overlap.iter().copied());
    };

    for unit in units {
        let unit_tokens = estimate_tokens(unit);
        if unit_tokens > MAX_TOKENS {
            // A single huge line: hard-split on words.
            flush(&mut pieces, &mut current, &mut current_tokens, current_start, &mut cursor);
            for (piece, s, e) in hard_split(unit, cursor) {
                pieces.push((piece, s, e));
            }
            cursor = current_start + unit.len() + 1;
            current_start = cursor;
            continue;
        }
        if current_tokens + unit_tokens > MAX_TOKENS && !current.is_empty() {
            flush(&mut pieces, &mut current, &mut current_tokens, current_start, &mut cursor);
            current_start = cursor;
        }
        current.push(unit);
        current_tokens += unit_tokens;
        cursor += unit.len() + 1;
    }
    flush(&mut pieces, &mut current, &mut current_tokens, current_start, &mut cursor);
    pieces
}

/// Word-boundary hard split for pathologically long single lines.
fn hard_split(line: &str, base_offset: usize) -> Vec<(String, usize, usize)> {
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut tokens = 0usize;
    let mut last_break = 0usize;
    for (i, c) in line.char_indices() {
        if c == ' ' {
            if tokens >= MAX_TOKENS {
                out.push((line[start..i].to_string(), base_offset + start, base_offset + i));
                // Overlap: restart ~10% before the break.
                start = last_break;
                tokens = (i - last_break) / 6;
            }
            last_break = i + 1;
            tokens += 1;
        }
    }
    if start < line.len() {
        out.push((line[start..].to_string(), base_offset + start, base_offset + line.len()));
    }
    out
}

/// Token estimate: whitespace words plus punctuation clusters — cheap,
/// deterministic, good enough for sizing (never for billing).
pub fn estimate_tokens(text: &str) -> usize {
    text.split_whitespace()
        .map(|w| {
            // Long words count multiple tokens; punctuation adds a bit.
            (w.len() / 5).max(1) + (!w.chars().next().is_some_and(|c| c.is_alphanumeric()) as usize)
        })
        .sum()
}
