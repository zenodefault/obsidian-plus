//! SQLite database handle: connection, pragmas, migrations (PLAN.md §78).
//!
//! The single storage backend for all derived state. On unrecoverable
//! corruption the database is quarantined and rebuilt from the vault on the
//! next sync — derived data is always disposable (§9).

use std::path::Path;

use super::schema;

/// Open (creating if needed) the brain database with pragmas applied and all
/// migrations run.
pub fn open(data_dir: &Path) -> Result<rusqlite::Connection, rusqlite::Error> {
    match open_once(data_dir) {
        Ok(conn) => Ok(conn),
        Err(e) if is_corruption(&e) => {
            // Quarantine a corrupt database and start fresh (§99 security
            // tests: corrupted database recovery). The vault is untouched.
            // Transient errors (locks, races) are NOT corruption and must
            // never destroy a healthy database.
            crate::utils::logging::log(
                crate::utils::logging::Level::Error,
                "db",
                "database corrupt, quarantining and rebuilding",
                serde_json::json!({ "error": e.to_string() }),
            );
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let quarantine = data_dir.join(format!("brain.db.corrupt-{stamp}"));
            let _ = std::fs::rename(data_dir.join("brain.db"), quarantine);
            // WAL/SHM sidecars belong to the quarantined database too.
            let _ = std::fs::remove_file(data_dir.join("brain.db-wal"));
            let _ = std::fs::remove_file(data_dir.join("brain.db-shm"));
            open_once(data_dir)
        }
        Err(e) => Err(e),
    }
}

/// One open attempt: connection, pragmas, migrations. Corruption can surface
/// at any of those stages (a garbage file fails at the first pragma), so all
/// of them flow through the caller's corruption check.
fn open_once(data_dir: &Path) -> Result<rusqlite::Connection, rusqlite::Error> {
    let db_path = data_dir.join("brain.db");
    if let Some(parent) = db_path.parent() {
        // Surface failures through Connection::open instead.
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = rusqlite::Connection::open(&db_path)?;
    apply_pragmas(&conn)?;
    schema::migrate(&conn)?;
    Ok(conn)
}

/// True only for genuine database corruption — never for locks or races.
fn is_corruption(e: &rusqlite::Error) -> bool {
    matches!(
        e.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase)
    )
}

/// Test hook for the corruption classifier (§99).
#[doc(hidden)]
pub fn is_corruption_for_test(e: &rusqlite::Error) -> bool {
    is_corruption(e)
}

/// Pragmas for a lightweight local process: WAL + normal sync are the
/// durability/perf sweet spot; foreign keys on; FTS5 tokenizer allocations.
fn apply_pragmas(conn: &rusqlite::Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;",
    )
}
