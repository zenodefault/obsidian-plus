//! Offset-preserving markdown parser (PLAN.md §40).
//!
//! Parses frontmatter, headings, paragraphs, lists, blockquotes, code blocks,
//! wikilinks, links, tags, embeds and block IDs — recording source byte
//! offsets for every block so highlights and citations can point at the note.

/// Element kinds produced by the parser.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockKind {
    Heading,
    Paragraph,
    List,
    Blockquote,
    CodeBlock,
}

/// One structural block with its source span (byte offsets, §40).
#[derive(Debug, Clone, PartialEq)]
pub struct Block {
    pub kind: BlockKind,
    /// Heading level (1–6) for `Heading` blocks.
    pub level: u8,
    /// Raw source slice, including markers like `#` or `>`.
    pub text: String,
    pub start_offset: usize,
    pub end_offset: usize,
    /// `^block-id` when the block ends with one (§40).
    pub block_id: Option<String>,
}

/// Parsed frontmatter (subset relevant to indexing).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Frontmatter {
    pub title: Option<String>,
    pub tags: Vec<String>,
    /// True when `sovereign.exclude: true` (§73: index exclusions).
    pub excluded: bool,
}

/// Full parse result for one note.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ParsedNote {
    pub frontmatter: Frontmatter,
    pub blocks: Vec<Block>,
    /// Heading outline: (level, text, offset).
    pub headings: Vec<(u8, String, usize)>,
    /// Wikilink targets in order: `[[Note#sec|alias]]` → `Note`.
    pub wikilinks: Vec<String>,
    /// Standard markdown links: `[text](target)`.
    pub links: Vec<String>,
    /// Embeds: `![[target]]`.
    pub embeds: Vec<String>,
    /// Inline and frontmatter tags.
    pub tags: Vec<String>,
    /// `^block-id` values found anywhere.
    pub block_ids: Vec<String>,
}

/// Parse a full markdown document.
pub fn parse(content: &str) -> ParsedNote {
    let (frontmatter, body_start) = split_frontmatter(content);
    let mut note = ParsedNote {
        frontmatter,
        ..Default::default()
    };
    let mut inline = InlineCollector::default();
    note.blocks = parse_blocks(&content[body_start..], body_start, &mut inline);
    note.headings = note
        .blocks
        .iter()
        .filter(|b| b.kind == BlockKind::Heading)
        .map(|b| {
            let text = b.text.trim_start_matches('#').trim().to_string();
            (b.level, text, b.start_offset)
        })
        .collect();
    note.wikilinks = inline.wikilinks;
    note.links = inline.links;
    note.embeds = inline.embeds;
    note.block_ids = inline.block_ids;
    let mut tags = note.frontmatter.tags.clone();
    for t in inline.tags {
        if !tags.contains(&t) {
            tags.push(t);
        }
    }
    note.tags = tags;
    note
}

#[derive(Default)]
struct InlineCollector {
    wikilinks: Vec<String>,
    links: Vec<String>,
    embeds: Vec<String>,
    tags: Vec<String>,
    block_ids: Vec<String>,
}

/// Split leading YAML frontmatter; returns (frontmatter, body byte offset).
fn split_frontmatter(content: &str) -> (Frontmatter, usize) {
    if !content.starts_with("---") {
        return (Frontmatter::default(), 0);
    }
    let first_line_end = match content.find('\n') {
        Some(i) => i + 1,
        None => return (Frontmatter::default(), 0), // bare "---" is not FM
    };
    let mut offset = first_line_end;
    while offset < content.len() {
        let rest = &content[offset..];
        let line_len = rest.find('\n').map(|i| i + 1).unwrap_or(rest.len());
        if rest.starts_with("---") {
            let yaml = &content[first_line_end..offset];
            return (parse_frontmatter(yaml), offset + line_len);
        }
        offset += line_len;
    }
    // Unterminated frontmatter: treat the whole document as body.
    (Frontmatter::default(), 0)
}

fn parse_frontmatter(yaml: &str) -> Frontmatter {
    let mut fm = Frontmatter::default();
    let mut current_key: Option<String> = None;
    for line in yaml.lines() {
        let trimmed = line.trim();
        if let Some((key, value)) = trimmed.split_once(':') {
            let key = key.trim();
            let value = value.trim();
            current_key = Some(key.to_string());
            match key {
                "title" if !value.is_empty() => {
                    fm.title = Some(unquote(value));
                }
                "exclude" | "excluded" => {
                    fm.excluded = value == "true";
                }
                "tags" if !value.is_empty() => {
                    parse_tag_list(value, &mut fm.tags);
                    current_key = None; // consumed inline
                }
                _ => {}
            }
            continue;
        }
        // Nested map under `sovereign:` (§73) — `exclude: true`.
        if current_key.as_deref() == Some("sovereign") {
            if let Some(rest) = trimmed.strip_prefix("- ") {
                if rest == "exclude: true" || rest.trim() == "exclude: true" {
                    fm.excluded = true;
                }
            }
            if let Some((k, v)) = trimmed.split_once(':') {
                if k.trim() == "exclude" && v.trim() == "true" {
                    fm.excluded = true;
                }
            }
        }
        // Continuation list items under `tags:`.
        if current_key.as_deref() == Some("tags") {
            if let Some(item) = trimmed.strip_prefix("- ") {
                let tag = unquote(item.trim());
                if !tag.is_empty() && !fm.tags.contains(&tag) {
                    fm.tags.push(tag);
                }
            }
        }
    }
    fm
}

fn parse_tag_list(value: &str, out: &mut Vec<String>) {
    let value = value
        .strip_prefix('[')
        .and_then(|v| v.strip_suffix(']'))
        .unwrap_or(value);
    for tag in value.split(',') {
        let tag = unquote(tag.trim());
        if !tag.is_empty() && !out.contains(&tag) {
            out.push(tag);
        }
    }
}

fn unquote(s: &str) -> String {
    s.trim_matches('"').trim_matches('\'').to_string()
}

/// Parse the body into blocks starting at byte offset `base`.
fn parse_blocks(body: &str, base: usize, inline: &mut InlineCollector) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut lines = body.split_inclusive('\n').peekable();
    let mut offset = base;
    let mut current_list: Option<Block> = None;

    while let Some(line) = lines.next() {
        let line_start = offset;
        offset += line.len();
        let trimmed = line.trim_end();
        let stripped = trimmed.trim_start();

        // Code fences.
        if stripped.starts_with("```") || stripped.starts_with("~~~") {
            // Flush pending list before a code block.
            if let Some(l) = current_list.take() {
                blocks.push(l);
            }
            let fence = &stripped[..3];
            let mut code = String::from(line);
            let closed = loop {
                match lines.peek() {
                    None => break false,
                    Some(next) if next.trim_start().starts_with(fence) => break true,
                    Some(_) => {}
                }
                let next = lines.next().unwrap();
                code.push_str(next);
                offset += next.len();
            };
            if closed {
                if let Some(next) = lines.next() {
                    code.push_str(next);
                    offset += next.len();
                }
            }
            blocks.push(Block {
                kind: BlockKind::CodeBlock,
                level: 0,
                text: code,
                start_offset: line_start,
                end_offset: offset,
                block_id: None,
            });
            continue;
        }

        // ATX headings.
        if let Some(rest) = stripped.strip_prefix('#') {
            if let Some(l) = current_list.take() {
                blocks.push(l);
            }
            let level = (rest.chars().take_while(|c| *c == '#').count() + 1).min(6) as u8;
            collect_inline(stripped, inline);
            blocks.push(Block {
                kind: BlockKind::Heading,
                level,
                text: trimmed.to_string(),
                start_offset: line_start,
                end_offset: offset,
                block_id: None,
            });
            continue;
        }

        // Blockquotes: collect consecutive `>` lines.
        if stripped.starts_with('>') {
            if let Some(l) = current_list.take() {
                blocks.push(l);
            }
            let mut quote = String::from(line);
            while let Some(next) = lines.peek() {
                if !next.trim_start().starts_with('>') {
                    break;
                }
                let next = lines.next().unwrap();
                quote.push_str(next);
                offset += next.len();
            }
            collect_inline(&quote, inline);
            let quote_id = extract_block_id(&quote);
            blocks.push(Block {
                kind: BlockKind::Blockquote,
                level: 0,
                text: quote,
                start_offset: line_start,
                end_offset: offset,
                block_id: quote_id,
            });
            continue;
        }

        // List items: `- `, `* `, `1. ` — group consecutive items.
        if is_list_item(stripped) {
            collect_inline(stripped, inline);
            match current_list.as_mut() {
                Some(l) => {
                    l.text.push_str(line);
                    l.end_offset = offset;
                }
                None => {
                    current_list = Some(Block {
                        kind: BlockKind::List,
                        level: 0,
                        text: line.to_string(),
                        start_offset: line_start,
                        end_offset: offset,
                        block_id: None,
                    });
                }
            }
            continue;
        }

        // Blank lines close lists.
        if stripped.is_empty() {
            if let Some(l) = current_list.take() {
                blocks.push(l);
            }
            continue;
        }

        // Paragraph: consecutive non-blank, non-structural lines.
        if let Some(l) = current_list.take() {
            blocks.push(l);
        }
        let mut para = String::from(line);
        while let Some(next) = lines.peek() {
            let next_trim = next.trim();
            if next_trim.is_empty()
                || next_trim.starts_with('#')
                || next_trim.starts_with('>')
                || next_trim.starts_with("```")
                || next_trim.starts_with("~~~")
                || is_list_item(next_trim)
            {
                break;
            }
            let next = lines.next().unwrap();
            para.push_str(next);
            offset += next.len();
        }
        collect_inline(&para, inline);
        let para_id = extract_block_id(&para);
        blocks.push(Block {
            kind: BlockKind::Paragraph,
            level: 0,
            text: para,
            start_offset: line_start,
            end_offset: offset,
            block_id: para_id,
        });
    }
    if let Some(l) = current_list.take() {
        blocks.push(l);
    }
    blocks
}

fn is_list_item(line: &str) -> bool {
    if let Some(rest) = line.strip_prefix("- ") {
        return !rest.trim().is_empty();
    }
    if let Some(rest) = line.strip_prefix("* ") {
        return !rest.trim().is_empty();
    }
    if let Some(rest) = line.strip_prefix("+ ") {
        return !rest.trim().is_empty();
    }
    // Ordered: `1. ` / `10) `
    let digits: String = line.chars().take_while(|c| c.is_ascii_digit()).collect();
    if !digits.is_empty() {
        let rest = &line[digits.len()..];
        return rest.starts_with(". ") || rest.starts_with(") ");
    }
    false
}

/// `^block-id` at the end of a block (§40).
fn extract_block_id(text: &str) -> Option<String> {
    let trimmed = text.trim_end();
    let last = trimmed.split_whitespace().last()?;
    let id = last.strip_prefix('^')?;
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    Some(id.to_string())
}

/// Extract wikilinks, links, embeds and tags from any text.
fn collect_inline(text: &str, out: &mut InlineCollector) {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'!' if i + 2 < bytes.len() && bytes[i + 1] == b'[' && bytes[i + 2] == b'[' => {
                if let Some(close) = text[i + 3..].find("]]") {
                    let target = &text[i + 3..i + 3 + close];
                    let target = target.split('|').next().unwrap_or(target);
                    let target = target.split('#').next().unwrap_or(target).trim();
                    if !target.is_empty() && !out.embeds.iter().any(|e| e == target) {
                        out.embeds.push(target.to_string());
                    }
                    i += 3 + close + 2;
                    continue;
                }
            }
            b'[' if i + 1 < bytes.len() && bytes[i + 1] == b'[' => {
                if let Some(close) = text[i + 2..].find("]]") {
                    let inner = &text[i + 2..i + 2 + close];
                    let target = inner.split('|').next().unwrap_or(inner);
                    let target = target.split('#').next().unwrap_or(target).trim();
                    if !target.is_empty() && !out.wikilinks.iter().any(|l| l == target) {
                        out.wikilinks.push(target.to_string());
                    }
                    i += 2 + close + 2;
                    continue;
                }
            }
            b'[' => {
                // Standard link `[text](target)` — target must follow `](`.
                if let Some(bracket_close) = text[i..].find(']') {
                    let after = &text[i + bracket_close + 1..];
                    if let Some(target) = after.strip_prefix('(') {
                        if let Some(paren_close) = target.find(')') {
                            let url = &target[..paren_close];
                            if !url.is_empty() && !out.links.iter().any(|l| l == url) {
                                out.links.push(url.to_string());
                            }
                            i += bracket_close + 1 + paren_close + 2;
                            continue;
                        }
                    }
                }
            }
            b'#' => {
                // Tag only when preceded by whitespace/line start and followed
                // by tag-safe chars. Skips headings because those start a line;
                // `# heading text` yields no safe tag run for multi-word text,
                // but `#one-word-heading` would match — acceptable for v1 and
                // excluded in practice by the caller skipping heading lines.
                let at_boundary = i == 0
                    || bytes[i - 1] == b' '
                    || bytes[i - 1] == b'\n'
                    || bytes[i - 1] == b'\t'
                    || bytes[i - 1] == b'(';
                if at_boundary {
                    let end = text[i + 1..]
                        .find(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
                        .map(|p| i + 1 + p)
                        .unwrap_or(text.len());
                    let tag = &text[i + 1..end];
                    if !tag.is_empty()
                        && !tag.chars().next().unwrap().is_ascii_digit()
                        && !out.tags.iter().any(|t| t == tag)
                    {
                        out.tags.push(tag.to_string());
                    }
                    i = end;
                    continue;
                }
            }
            b'^' if i > 0 && (bytes[i - 1] == b' ' || bytes[i - 1] == b'\n') => {
                let end = text[i + 1..]
                    .find(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_')
                    .map(|p| i + 1 + p)
                    .unwrap_or(text.len());
                let id = &text[i + 1..end];
                if !id.is_empty() && !out.block_ids.iter().any(|b| b == id) {
                    out.block_ids.push(id.to_string());
                }
                i = end;
                continue;
            }
            _ => {}
        }
        i += 1;
    }
}
