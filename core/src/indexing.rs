//! Note index: SQLite persistence for notes + chunks + FTS (§78–80, §94).

use crate::chunking;
use crate::parser;
use crate::storage::db;
use rusqlite::{params, Connection, OptionalExtension};

/// A note row as stored in `notes`.
#[derive(Debug, Clone, PartialEq)]
pub struct NoteRow {
    pub id: String,
    pub path: String,
    pub title: Option<String>,
    pub sha256: String,
    pub mtime: i64,
    pub size: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Search hit with chunk provenance for citations (§58).
#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
    pub note_id: String,
    pub note_path: String,
    pub chunk_id: String,
    pub heading_path: String,
    pub snippet: String,
    /// bm25 rank from FTS5 (lower is better; negated for sorting).
    pub rank: f64,
}

/// Open the index database for a data dir.
pub struct NoteIndex {
    conn: Connection,
}

impl NoteIndex {
    pub fn open(data_dir: &std::path::Path) -> Result<Self, rusqlite::Error> {
        Ok(Self {
            conn: db::open(data_dir)?,
        })
    }

    /// Direct connection access for the job queue and future modules.
    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    /// Insert or update a note: parser → chunker → transaction (§106).
    /// Returns the note id (kept stable when the path already exists).
    pub fn upsert_note(
        &self,
        path: &str,
        content: &str,
        mtime: i64,
        size: i64,
    ) -> Result<String, rusqlite::Error> {
        let parsed = parser::parse(content);
        let title = parsed
            .frontmatter
            .title
            .clone()
            .or_else(|| parsed.headings.first().map(|(_, t, _)| t.clone()))
            .or_else(|| fallback_title(path));
        let sha = crate::vault::manager::hash_content(content);
        let now = now_millis();

        let chunks = chunking::chunk(content);

        let tx = self.conn.unchecked_transaction()?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT id FROM notes WHERE path = ?1",
                params![path],
                |r| r.get(0),
            )
            .optional()?;
        let existed = existing.is_some();
        let note_id = match existing {
            Some(id) => id,
            None => uuid::Uuid::new_v4().to_string(),
        };
        if existed {
            tx.execute(
                "UPDATE notes SET sha256 = ?2, title = ?3, mtime = ?4, size = ?5, updated_at = ?6, status = 'active' WHERE id = ?1",
                params![note_id, sha, title, mtime, size, now],
            )?;
            tx.execute("DELETE FROM chunks WHERE note_id = ?1", params![note_id])?;
        } else {
            tx.execute(
                "INSERT INTO notes (id, path, title, sha256, mtime, size, status, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?7)",
                params![note_id, path, title, sha, mtime, size, now],
            )?;
        }

        for chunk in &chunks {
            tx.execute(
                "INSERT INTO chunks (id, note_id, ordinal, heading_path, text, start_offset, end_offset, token_estimate)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    note_id,
                    chunk.ordinal as i64,
                    chunk.heading_path,
                    chunk.text,
                    chunk.start_offset as i64,
                    chunk.end_offset as i64,
                    chunk.token_estimate as i64,
                ],
            )?;
        }
        tx.commit()?;
        Ok(note_id)
    }

    /// Delete a note and its chunks (cascades FTS via triggers).
    pub fn delete_note(&self, path: &str) -> Result<bool, rusqlite::Error> {
        let deleted = self.conn.execute(
            "DELETE FROM notes WHERE path = ?1",
            params![path],
        )?;
        Ok(deleted > 0)
    }

    /// Move a note's identity to a new path (rename, §39).
    pub fn rename_note(&self, old_path: &str, new_path: &str) -> Result<bool, rusqlite::Error> {
        let updated = self.conn.execute(
            "UPDATE notes SET path = ?2, updated_at = ?3 WHERE path = ?1",
            params![old_path, new_path, now_millis()],
        )?;
        Ok(updated > 0)
    }

    /// Number of active notes (health surfaces).
    pub fn total_notes(&self) -> Result<i64, rusqlite::Error> {
        self.conn
            .query_row("SELECT COUNT(*) FROM notes WHERE status = 'active'", [], |r| {
                r.get(0)
            })
    }

    /// FTS5 keyword search (fast path, §94). Returns hits with snippets.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>, rusqlite::Error> {
        let safe = fts_escape(query);
        if safe.is_empty() {
            return Ok(Vec::new());
        }
        let mut stmt = self.conn.prepare(
            "SELECT n.id, n.path, c.id, c.heading_path,
                    snippet(chunks_fts, 0, '«', '»', '…', 12),
                    bm25(chunks_fts) AS rank
             FROM chunks_fts f
             JOIN chunks c ON c.rowid = f.rowid
             JOIN notes n ON n.id = c.note_id
             WHERE chunks_fts MATCH ?1 AND n.status = 'active'
             ORDER BY rank
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![safe, limit as i64], |row| {
            Ok(SearchHit {
                note_id: row.get(0)?,
                note_path: row.get(1)?,
                chunk_id: row.get(2)?,
                heading_path: row.get(3)?,
                snippet: row.get(4)?,
                rank: row.get(5)?,
            })
        })?;
        rows.collect()
    }

    /// Look up a note id by path (sync bridges).
    pub fn note_id_by_path(&self, path: &str) -> Result<Option<String>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT id FROM notes WHERE path = ?1",
                params![path],
                |r| r.get(0),
            )
            .optional()
    }
}

/// FTS5 query escaping: wrap each term in double quotes so user input is
/// treated as literal text, never as query syntax (§67 adjacent hygiene).
fn fts_escape(query: &str) -> String {
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect();
    terms.join(" ")
}

/// Derive a title from the path when content offers none.
fn fallback_title(path: &str) -> Option<String> {
    path.rsplit('/').next().map(|f| {
        f.trim_end_matches(".md")
            .trim_end_matches(".markdown")
            .to_string()
    })
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
