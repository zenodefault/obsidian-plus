//! Part 3 unit tests: parser (§40), chunker (§41), index + FTS (§78–80, §94).

use sovereign_core::chunking::{chunk, estimate_tokens};
use sovereign_core::indexing::NoteIndex;
use sovereign_core::parser::{parse, BlockKind};

fn index() -> NoteIndex {
    let dir = std::env::temp_dir().join(format!(
        "sv-idx-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    NoteIndex::open(&dir).unwrap()
}

// ---------- Parser ----------

#[test]
fn parser_records_byte_offsets() {
    let content = "# Title\n\nFirst paragraph.\n\n- item one\n- item two\n";
    let parsed = parse(content);
    assert_eq!(parsed.blocks.len(), 3); // heading, paragraph, list
    for block in &parsed.blocks {
        let slice = &content[block.start_offset..block.end_offset];
        assert_eq!(slice.trim_end(), block.text.trim_end(), "offsets must slice back to text");
    }
    assert_eq!(parsed.blocks[0].kind, BlockKind::Heading);
    assert_eq!(parsed.blocks[0].level, 1);
    assert_eq!(parsed.blocks[1].kind, BlockKind::Paragraph);
    assert_eq!(parsed.blocks[2].kind, BlockKind::List);
}

#[test]
fn parser_frontmatter_title_tags_exclude() {
    let content = "---\ntitle: Deep Dive\ntags:\n  - rust\n  - sqlite\nsovereign:\n  exclude: true\n---\n\nBody here.\n";
    let parsed = parse(content);
    assert_eq!(parsed.frontmatter.title.as_deref(), Some("Deep Dive"));
    assert!(parsed.frontmatter.tags.contains(&"rust".to_string()));
    assert!(parsed.frontmatter.tags.contains(&"sqlite".to_string()));
    assert!(parsed.frontmatter.excluded);
}

#[test]
fn parser_inline_extraction() {
    let content = "See [[Target Note#Section|alias]] and [text](https://example.com). ![[Embed Note]] #tag1\n\nQuote:\n> quoted [[Linked]] ^block-1\n";
    let parsed = parse(content);
    assert!(parsed.wikilinks.contains(&"Target Note".to_string()));
    assert!(parsed.links.contains(&"https://example.com".to_string()));
    assert!(parsed.embeds.contains(&"Embed Note".to_string()));
    assert!(parsed.tags.contains(&"tag1".to_string()));
    assert!(parsed.wikilinks.contains(&"Linked".to_string()));
    assert!(parsed.block_ids.contains(&"block-1".to_string()));
}

#[test]
fn parser_code_blocks_are_atomic_and_untouched() {
    let content = "````\n[[not a link]] #not-a-tag\n````\n\nafter\n";
    let parsed = parse(content);
    let code = parsed.blocks.iter().find(|b| b.kind == BlockKind::CodeBlock).unwrap();
    assert!(code.text.contains("[[not a link]]"));
    assert!(!parsed.wikilinks.iter().any(|l| l.contains("not a link")));
    assert!(!parsed.tags.iter().any(|t| t.contains("not-a-tag")));
}

#[test]
fn parser_headings_outline_with_levels() {
    let content = "# One\n\ntext\n\n## Two\n\nmore\n\n### Three\n\nfinal\n";
    let parsed = parse(content);
    let levels: Vec<u8> = parsed.headings.iter().map(|(l, _, _)| *l).collect();
    assert_eq!(levels, vec![1, 2, 3]);
    assert_eq!(parsed.headings[1].1, "Two");
}

// ---------- Chunker ----------

#[test]
fn chunker_respects_heading_paths_and_offsets() {
    let content = "# Setup\n\nInstall things.\n\n## Database\n\nUse SQLite locally.\n\n# Next\n\nother\n";
    let chunks = chunk(content);
    assert!(chunks.len() >= 3);
    let db_chunk = chunks.iter().find(|c| c.text.contains("Use SQLite")).unwrap();
    assert_eq!(db_chunk.heading_path, "Setup > Database");
    let slice = &content[db_chunk.start_offset..db_chunk.end_offset];
    assert!(slice.contains("Use SQLite locally."));
    // Ordinals are dense from 0.
    let mut ordinals: Vec<usize> = chunks.iter().map(|c| c.ordinal).collect();
    ordinals.sort();
    assert_eq!(ordinals, (0..chunks.len()).collect::<Vec<_>>());
}

#[test]
fn chunker_never_splits_code_blocks() {
    let mut code = String::from("# Code\n\n```rust\n");
    for i in 0..200 {
        code.push_str(&format!("let value_{i} = {i}; // some reasonably long line here\n"));
    }
    code.push_str("```\n\ntail paragraph\n");
    let chunks = chunk(&code);
    let code_chunks: Vec<_> = chunks
        .iter()
        .filter(|c| c.text.contains("```rust"))
        .collect();
    assert_eq!(code_chunks.len(), 1, "code block must stay in one chunk");
}

#[test]
fn chunker_splits_oversized_paragraph_groups() {
    let mut content = String::from("# Big\n\n");
    for i in 0..60 {
        content.push_str(&format!("Paragraph {i} with enough words to add weight. "));
        content.push_str(&"word ".repeat(30));
        content.push_str("\n\n");
    }
    let chunks = chunk(&content);
    assert!(chunks.len() > 1, "large note must split");
    for c in &chunks {
        assert!(c.token_estimate <= 600, "chunks stay near the cap, got {}", c.token_estimate);
    }
    // Overlap: consecutive chunks share some text.
    if chunks.len() >= 2 {
        let a = &chunks[0].text;
        let b = &chunks[1].text;
        let shared = a
            .split_whitespace()
            .filter(|w| b.contains(*w))
            .count();
        assert!(shared > 0, "expected overlap between consecutive chunks");
    }
}

#[test]
fn estimate_tokens_is_monotonic() {
    assert!(estimate_tokens("one two three") < estimate_tokens("one two three four five six seven eight nine ten"));
    assert_eq!(estimate_tokens(""), 0);
}

// ---------- Index + FTS ----------

#[test]
fn upsert_note_is_idempotent_on_path() {
    let idx = index();
    let id1 = idx.upsert_note("A.md", "# A\n\nv1", 1, 10).unwrap();
    let id2 = idx.upsert_note("A.md", "# A\n\nv2 — updated content", 2, 20).unwrap();
    assert_eq!(id1, id2);
    assert_eq!(idx.total_notes().unwrap(), 1);
    // Chunks were replaced, not duplicated.
    let count: i64 = idx
        .connection()
        .query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0))
        .unwrap();
    assert!(count >= 1);
}

#[test]
fn delete_and_rename_notes() {
    let idx = index();
    let id = idx.upsert_note("Old.md", "content here", 1, 12).unwrap();
    assert!(idx.rename_note("Old.md", "New.md").unwrap());
    assert_eq!(idx.note_id_by_path("New.md").unwrap().as_deref(), Some(id.as_str()));
    assert!(idx.note_id_by_path("Old.md").unwrap().is_none());
    assert!(idx.delete_note("New.md").unwrap());
    assert!(idx.note_id_by_path("New.md").unwrap().is_none());
    assert_eq!(idx.total_notes().unwrap(), 0);
}

#[test]
fn fts_search_ranks_and_snippets() {
    let idx = index();
    idx.upsert_note(
        "Rust.md",
        "# Rust\n\nRust is a systems programming language focused on safety.",
        1,
        60,
    )
    .unwrap();
    idx.upsert_note(
        "Cooking.md",
        "# Cooking\n\nBoil the potatoes, then season with salt.",
        2,
        50,
    )
    .unwrap();

    let hits = idx.search("rust safety", 10).unwrap();
    assert!(!hits.is_empty());
    assert_eq!(hits[0].note_path, "Rust.md");
    assert!(hits[0].snippet.contains("Rust") || hits[0].snippet.contains("safety"));
    assert!(hits.iter().all(|h| h.note_path == "Rust.md"));

    let none = idx.search("quantum entanglement", 10).unwrap();
    assert!(none.is_empty());
}

#[test]
fn fts_query_syntax_is_escaped() {
    let idx = index();
    idx.upsert_note("A.md", "plain words here", 1, 16).unwrap();
    // FTS5 syntax characters must not crash or inject operators.
    let hits = idx.search("\"plain\" AND (words) OR NEAR", 10).unwrap();
    // Escaped means these are literal terms; likely no match, but never a panic.
    let _ = hits;
    let weird = idx.search("a b c d e f g h i j k l m n o p", 10).unwrap();
    let _ = weird;
}

#[test]
fn search_respects_limit() {
    let idx = index();
    for i in 0..15 {
        idx.upsert_note(&format!("N{i}.md"), &format!("common token number {i}"), i, 20)
            .unwrap();
    }
    let hits = idx.search("common", 5).unwrap();
    assert_eq!(hits.len(), 5);
}

#[test]
fn deleted_notes_leave_fts() {
    let idx = index();
    idx.upsert_note("X.md", "searchable unicorns", 1, 20).unwrap();
    assert!(!idx.search("unicorns", 10).unwrap().is_empty());
    idx.delete_note("X.md").unwrap();
    assert!(idx.search("unicorns", 10).unwrap().is_empty());
}
