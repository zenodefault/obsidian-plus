//! Deterministic markdown metadata extraction (title, tags, wikilinks).
//!
//! Deliberately simple and fully testable: this feeds sync state only. The
//! full offset-preserving parser arrives with Part 3's chunking (PLAN.md §40).

/// Extracted note metadata.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct NoteMetadata {
    pub title: Option<String>,
    pub tags: Vec<String>,
    pub links: Vec<String>,
    /// Short excerpt for review surfaces — never the full body (§97).
    pub excerpt: String,
    /// Number of wikilinks found.
    pub link_count: usize,
}

/// Extract metadata from markdown content.
pub fn extract_metadata(content: &str) -> NoteMetadata {
    let mut meta = NoteMetadata::default();
    let mut in_frontmatter = false;
    let mut frontmatter_done = false;
    let mut in_code_block = false;
    let mut excerpt_parts: Vec<&str> = Vec::new();

    for line in content.lines() {
        let trimmed = line.trim();

        if !frontmatter_done {
            if trimmed == "---" {
                if in_frontmatter {
                    in_frontmatter = false;
                    frontmatter_done = true;
                } else if meta.title.is_none() && excerpt_parts.is_empty() {
                    in_frontmatter = true;
                }
                continue;
            }
            if in_frontmatter {
                parse_frontmatter_line(trimmed, &mut meta);
                continue;
            }
            frontmatter_done = true;
        }

        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code_block = !in_code_block;
            continue;
        }
        if in_code_block {
            continue;
        }

        // First heading wins as title if frontmatter had none.
        if meta.title.is_none() && trimmed.starts_with("# ") {
            meta.title = Some(trimmed[2..].trim().to_string());
        }

        parse_inline_tags(trimmed, &mut meta.tags);
        parse_wikilinks(trimmed, &mut meta.links);

        // Excerpt: first non-heading, non-empty content lines.
        if excerpt_parts.len() < 3 && !trimmed.is_empty() && !trimmed.starts_with('#') {
            excerpt_parts.push(trimmed);
        }
    }

    meta.link_count = meta.links.len();
    meta.excerpt = excerpt_parts.join(" ");
    if meta.excerpt.len() > 200 {
        meta.excerpt.truncate(200);
    }
    meta
}

fn parse_frontmatter_line(line: &str, meta: &mut NoteMetadata) {
    if let Some(rest) = line.strip_prefix("title:") {
        let value = rest.trim().trim_matches('"').trim_matches('\'');
        if !value.is_empty() {
            meta.title = Some(value.to_string());
        }
        return;
    }
    // Inline tag list: `tags: [a, b]` or `tags: a, b`.
    if let Some(rest) = line.strip_prefix("tags:") {
        let value = rest.trim();
        let value = value
            .strip_prefix('[')
            .and_then(|v| v.strip_suffix(']'))
            .unwrap_or(value);
        for tag in value.split(',') {
            let tag = tag.trim().trim_matches('"').trim_matches('\'');
            if !tag.is_empty() && !meta.tags.iter().any(|t| t == tag) {
                meta.tags.push(tag.to_string());
            }
        }
    }
}

/// Inline `#tag` outside links/headings; frontmatter tags are handled above.
fn parse_inline_tags(line: &str, tags: &mut Vec<String>) {
    for word in line.split_whitespace() {
        // Trim trailing punctuation only — the leading `#` is the tag marker.
        let candidate = word.trim_end_matches(|c: char| !c.is_alphanumeric() && c != '_' && c != '-');
        let Some(tag) = candidate.strip_prefix('#') else {
            continue;
        };
        if tag.is_empty()
            || tag.chars().next().is_some_and(|c| c.is_ascii_digit())
            || tag.chars().any(|c| !c.is_alphanumeric() && c != '_' && c != '-')
        {
            continue;
        }
        if !tags.iter().any(|t| t == tag) {
            tags.push(tag.to_string());
        }
    }
}

/// `[[wikilink|alias]]` and `[[note#heading]]` → note target.
fn parse_wikilinks(line: &str, links: &mut Vec<String>) {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            if let Some(close) = line[i + 2..].find("]]") {
                let inner = &line[i + 2..i + 2 + close];
                let target = inner.split('|').next().unwrap_or(inner);
                let target = target.split('#').next().unwrap_or(target).trim();
                if !target.is_empty() && !links.iter().any(|l| l == target) {
                    links.push(target.to_string());
                }
                i += 2 + close + 2;
                continue;
            }
        }
        i += 1;
    }
}
