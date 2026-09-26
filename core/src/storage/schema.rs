//! Schema migrations. Each migration runs once, inside a transaction, tracked
//! in `schema_migrations` (§78: minimum tables; chunks get an FTS5 index per
//! §42–43 and §80).

use rusqlite::Connection;

/// Numbered, append-only migrations. Never edit a shipped migration.
pub const MIGRATIONS: &[&str] = &[
    // v1: core tables (§78–86).
    r#"
    CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        title TEXT,
        sha256 TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );

    CREATE TABLE chunks (
        id TEXT PRIMARY KEY,
        note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        heading_path TEXT NOT NULL,
        text TEXT NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        token_estimate INTEGER NOT NULL,
        embedding BLOB
    );
    CREATE INDEX idx_chunks_note ON chunks(note_id, ordinal);

    CREATE TABLE entities (
        id TEXT PRIMARY KEY,
        canonical_name TEXT NOT NULL,
        type TEXT NOT NULL,
        aliases TEXT NOT NULL DEFAULT '[]',
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        source_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE relationships (
        id TEXT PRIMARY KEY,
        source_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        relationship_type TEXT NOT NULL,
        target_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        confidence REAL NOT NULL DEFAULT 1.0,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );

    CREATE TABLE claims (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        claim_type TEXT NOT NULL,
        polarity INTEGER NOT NULL DEFAULT 1,
        confidence REAL NOT NULL DEFAULT 1.0,
        source_note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
        source_offset INTEGER,
        valid_from INTEGER,
        valid_until INTEGER,
        status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'candidate',
        confidence REAL NOT NULL DEFAULT 1.0,
        user_verified INTEGER NOT NULL DEFAULT 0,
        valid_from INTEGER,
        valid_until INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );

    CREATE TABLE memory_sources (
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
        claim_id TEXT REFERENCES claims(id) ON DELETE SET NULL,
        excerpt TEXT,
        PRIMARY KEY (memory_id, note_id, claim_id)
    );

    CREATE TABLE contradictions (
        id TEXT PRIMARY KEY,
        claim_a_id TEXT REFERENCES claims(id) ON DELETE CASCADE,
        claim_b_id TEXT REFERENCES claims(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
    );

    CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        run_after INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER,
        finished_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_jobs_claim ON jobs(status, run_after);

    CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        user_request TEXT NOT NULL,
        status TEXT NOT NULL,
        risk_level TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER
    );

    CREATE TABLE agent_steps (
        id TEXT PRIMARY KEY,
        agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        step_number INTEGER NOT NULL,
        tool TEXT NOT NULL,
        input TEXT NOT NULL,
        output TEXT,
        status TEXT NOT NULL,
        approval_required INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE operations (
        id TEXT PRIMARY KEY,
        agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
        reason TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        approval_status TEXT NOT NULL DEFAULT 'pending',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        completed_at INTEGER
    );

    CREATE TABLE operation_files (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
        note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
        path TEXT NOT NULL,
        old_hash TEXT,
        new_hash TEXT,
        old_content_ref TEXT,
        new_content_ref TEXT
    );

    CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        operation_id TEXT,
        actor TEXT NOT NULL,
        reason TEXT,
        target TEXT,
        approval TEXT,
        result TEXT NOT NULL,
        previous_hash TEXT,
        new_hash TEXT,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    "#,
    // v2: FTS5 keyword index over chunks (§42, §80). External-content table
    // keeps the canonical text in `chunks` and stays consistent via triggers.
    r#"
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
        text,
        content='chunks',
        content_rowid='rowid',
        tokenize='porter unicode61'
    );

    CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text)
        VALUES ('delete', old.rowid, old.text);
    END;
    CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text)
        VALUES ('delete', old.rowid, old.text);
        INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
    "#,
    // v3: knowledge layer provenance (§45–47, §68–69). Entity mentions keep
    // source_count exact; note_links power broken-link detection; per-note
    // relationship provenance makes re-extraction idempotent.
    r#"
    ALTER TABLE relationships ADD COLUMN source_note_id TEXT REFERENCES notes(id) ON DELETE CASCADE;

    CREATE TABLE IF NOT EXISTS entity_mentions (
        entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        PRIMARY KEY (entity_id, note_id)
    );

    CREATE TABLE IF NOT EXISTS note_links (
        note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        target TEXT NOT NULL,
        resolved_note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
        PRIMARY KEY (note_id, target)
    );

    CREATE INDEX IF NOT EXISTS idx_claims_note ON claims(source_note_id);
    CREATE INDEX IF NOT EXISTS idx_mentions_entity ON entity_mentions(entity_id);
    CREATE INDEX IF NOT EXISTS idx_links_target ON note_links(resolved_note_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_provenance
        ON relationships(source_entity_id, relationship_type, target_entity_id, source_note_id);
    "#,
    // v4: agent & safety (§60, §85–86). Operations gain the columns the
    // engine needs: per-file action, move target and content payloads (§66:
    // audit keeps ids and outcomes only, payloads live here for rollback).
    r#"
    ALTER TABLE operation_files ADD COLUMN action TEXT NOT NULL DEFAULT 'edit';
    ALTER TABLE operation_files ADD COLUMN new_path TEXT;
    ALTER TABLE operation_files ADD COLUMN content TEXT;
    ALTER TABLE operation_files ADD COLUMN old_content TEXT;

    CREATE INDEX IF NOT EXISTS idx_operations_status ON operations(status);
    CREATE INDEX IF NOT EXISTS idx_operation_files_op ON operation_files(operation_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at);
    "#,
];

/// Apply all pending migrations. The bookkeeping table is created inside an
/// IMMEDIATE transaction so concurrent openers serialize instead of racing.
pub fn migrate(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "BEGIN IMMEDIATE;
         CREATE TABLE IF NOT EXISTS schema_migrations (
             version INTEGER PRIMARY KEY,
             applied_at INTEGER NOT NULL
         );
         COMMIT;",
    )?;
    let current: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |r| r.get(0),
    )?;
    for (idx, sql) in MIGRATIONS.iter().enumerate() {
        let version = (idx + 1) as i64;
        if version <= current {
            continue;
        }
        conn.execute_batch("BEGIN IMMEDIATE;")?;
        let applied = conn.execute_batch(sql);
        match applied {
            Ok(()) => {
                conn.execute(
                    "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
                    rusqlite::params![version, now_millis()],
                )?;
                conn.execute_batch("COMMIT;")?;
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;");
                return Err(e);
            }
        }
    }
    Ok(())
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
