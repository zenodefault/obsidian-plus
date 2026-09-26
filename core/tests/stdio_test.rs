//! Integration test: spawns the real `sovereign-core` binary and speaks NDJSON
//! over its stdio — health, unknown method, malformed input recovery, shutdown.

use serde_json::json;
use sovereign_core::ipc::{read_envelope, write_envelope};
use sovereign_core::protocol::{Envelope, ErrorCode};
use std::io::{BufReader, Write};
use std::process::{Child, Command, Stdio};

struct CoreProc {
    child: Child,
}

impl CoreProc {
    fn spawn() -> Self {
        let tmp = std::env::temp_dir().join(format!(
            "sovereign-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .subsec_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        Self::spawn_in(&tmp)
    }

    /// Spawn with an explicit data dir (tests that exercise persistence).
    fn spawn_in(dir: &std::path::Path) -> Self {
        let bin = env!("CARGO_BIN_EXE_sovereign-core");
        let child = Command::new(bin)
            .arg("--data-dir")
            .arg(dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("failed to spawn core");
        Self { child }
    }

    fn request(&mut self, env: &Envelope) -> Envelope {
        let stdin = self.child.stdin.as_mut().unwrap();
        write_envelope(stdin, env).unwrap();
        let stdout = self.child.stdout.as_mut().unwrap();
        let mut reader = BufReader::new(stdout);
        read_envelope(&mut reader).unwrap().expect("core replied")
    }
}

impl Drop for CoreProc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn core_serves_health_unknown_and_malformed_then_shuts_down() {
    let mut core = CoreProc::spawn();

    // 1. Health.
    let reply = core.request(&Envelope::request("r1", "core.health", json!({})));
    assert_eq!(reply.id.as_deref(), Some("r1"));
    let result = reply.result.expect("health result");
    assert_eq!(result["status"], "ok");
    assert_eq!(result["protocol_version"], 1);

    // 2. Unknown method → typed METHOD_NOT_FOUND.
    let reply = core.request(&Envelope::request("r2", "brain.ask", json!({})));
    let err = reply.error.expect("error");
    assert_eq!(err.code, ErrorCode::MethodNotFound);
    assert_eq!(err.request_id.as_deref(), Some("r2"));

    // 3. Malformed line → PARSE_ERROR, core keeps serving.
    {
        let stdin = core.child.stdin.as_mut().unwrap();
        stdin.write_all(b"{oops not json\n").unwrap();
        stdin.flush().unwrap();
    }
    let reply = {
        let stdout = core.child.stdout.as_mut().unwrap();
        let mut reader = BufReader::new(stdout);
        read_envelope(&mut reader).unwrap().expect("parse error reply")
    };
    assert_eq!(reply.error.unwrap().code, ErrorCode::ParseError);

    // 4. Still alive after the malformed line.
    let reply = core.request(&Envelope::request("r3", "core.health", json!({})));
    assert_eq!(reply.id.as_deref(), Some("r3"));

    // 5. Shutdown → reply, then the process exits on its own.
    let reply = core.request(&Envelope::request("r4", "core.shutdown", json!({})));
    assert_eq!(reply.result.expect("shutdown result")["shutting_down"], true);

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match core.child.try_wait().unwrap() {
            Some(status) => {
                assert!(status.success(), "core exited with {status}");
                break;
            }
            None if std::time::Instant::now() > deadline => {
                panic!("core did not exit after shutdown");
            }
            None => std::thread::sleep(std::time::Duration::from_millis(20)),
        }
    }
}

#[test]
fn vault_sync_round_trip_over_stdio() {
    let shared_dir = std::env::temp_dir().join(format!(
        "sovereign-persist-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos()
    ));
    std::fs::create_dir_all(&shared_dir).unwrap();
    let mut core = CoreProc::spawn_in(&shared_dir);

    // Begin.
    let reply = core.request(&Envelope::request(
        "s1",
        "vault.sync.begin",
        json!({"rebuild": false}),
    ));
    let session = reply.result.expect("begin result")["session_id"]
        .as_str()
        .unwrap()
        .to_string();

    // Batch: one new note.
    let content = "# Hello\n\nWorld with [[Other]]. #tag\n";
    let reply = core.request(&Envelope::request(
        "s2",
        "vault.sync.batch",
        json!({
            "session_id": session,
            "notes": [{
                "path": "Notes/Hello.md",
                "hash": sovereign_core::vault::manager::hash_content(content),
                "mtime": 123,
                "size": content.len(),
            }],
        }),
    ));
    assert_eq!(reply.result.expect("batch result")["received"], 1);

    // Commit: must request the note's content.
    let reply = core.request(&Envelope::request(
        "s3",
        "vault.sync.commit",
        json!({"session_id": session}),
    ));
    let result = reply.result.expect("commit result");
    assert_eq!(result["added"][0], "Notes/Hello.md");
    assert_eq!(result["to_fetch"][0], "Notes/Hello.md");

    // Note upload with hash-verified content.
    let reply = core.request(&Envelope::request(
        "s4",
        "vault.sync.note",
        json!({
            "session_id": session,
            "path": "Notes/Hello.md",
            "hash": sovereign_core::vault::manager::hash_content(content),
            "mtime": 123,
            "size": content.len(),
            "content": content,
        }),
    ));
    let note_id = reply.result.expect("note result")["note_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(!note_id.is_empty());

    // Finish.
    let reply = core.request(&Envelope::request(
        "s5",
        "vault.sync.finish",
        json!({"session_id": session}),
    ));
    let result = reply.result.expect("finish result");
    assert_eq!(result["total_notes"], 1);
    assert_eq!(result["persisted"], true);

    // State readable in a *later process*: persistence actually persists.
    drop(core);
    let mut core2 = CoreProc::spawn_in(&shared_dir);
    let reply = core2.request(&Envelope::request("t1", "vault.state.get", json!({"include_metadata": true})));
    let state = reply.result.expect("state result");
    assert_eq!(state["total_notes"], 1);
    assert_eq!(state["notes"][0]["note_id"], json!(note_id));
    assert_eq!(state["notes"][0]["title"], "Hello");

    // Search over the synced content (FTS5, Part 3).
    let reply = core2.request(&Envelope::request(
        "t3",
        "search.query",
        json!({"query": "world", "limit": 10}),
    ));
    let hits = reply.result.expect("search result")["hits"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0]["note_path"], "Notes/Hello.md");
    assert!(hits[0]["snippet"].is_string());

    // Empty query is rejected; syntax characters never crash the server.
    let reply = core2.request(&Envelope::request("t4", "search.query", json!({"query": "   "})));
    assert_eq!(reply.error.unwrap().code, ErrorCode::InvalidParams);
    let reply = core2.request(&Envelope::request(
        "t5",
        "search.query",
        json!({"query": "\"quoted\" AND (paren) OR NEAR"}),
    ));
    assert!(reply.error.is_none() || reply.result.is_some());

    // Health summary reflects the synced note (Part 4).
    let reply = core2.request(&Envelope::request("t6", "health.summary", json!({})));
    let health = reply.result.expect("health result");
    assert_eq!(health["total_notes"], 1);
    assert!(health["total_chunks"].as_i64().unwrap() >= 1);
    assert_eq!(health["failed_jobs"], 0);

    // Sync a duplicate pair (inventory includes the existing note) →
    // duplicate candidates appear (§69), nothing is deleted.
    let dup_content = "Duplicated body text.";
    let hello_content = "# Hello\n\nWorld with [[Other]]. #tag\n";
    let reply = core2.request(&Envelope::request("t7", "vault.sync.begin", json!({})));
    let session = reply.result.expect("begin")["session_id"].as_str().unwrap().to_string();
    core2.request(&Envelope::request(
        "t8",
        "vault.sync.batch",
        json!({
            "session_id": session,
            "notes": [
                {"path": "Notes/Hello.md", "hash": sovereign_core::vault::manager::hash_content(hello_content), "mtime": 5, "size": hello_content.len()},
                {"path": "Copy1.md", "hash": sovereign_core::vault::manager::hash_content(dup_content), "mtime": 5, "size": dup_content.len()},
                {"path": "Copy2.md", "hash": sovereign_core::vault::manager::hash_content(dup_content), "mtime": 5, "size": dup_content.len()}
            ]
        }),
    ));
    core2.request(&Envelope::request("t9", "vault.sync.commit", json!({"session_id": session})));
    for p in ["Copy1.md", "Copy2.md"] {
        core2.request(&Envelope::request(
            "t10",
            "vault.sync.note",
            json!({
                "session_id": session,
                "path": p,
                "hash": sovereign_core::vault::manager::hash_content(dup_content),
                "mtime": 5,
                "size": dup_content.len(),
                "content": dup_content
            }),
        ));
    }
    core2.request(&Envelope::request("t11", "vault.sync.finish", json!({"session_id": session})));

    let reply = core2.request(&Envelope::request("t12", "health.summary", json!({})));
    let health = reply.result.expect("health result");
    let dupes = health["duplicate_candidates"].as_array().unwrap();
    assert_eq!(dupes.len(), 1, "exact duplicate pair detected");
    assert_eq!(health["total_notes"], 3, "duplicates are reported, never deleted");

    core2
        .request(&Envelope::request("t2", "core.shutdown", json!({})));
}

#[test]
fn core_exits_cleanly_on_stdin_eof() {
    let mut core = CoreProc::spawn();
    core.request(&Envelope::request("r1", "core.health", json!({})));
    // Drop stdin: core should treat EOF as exit signal (orphan protection).
    core.child.stdin.take().unwrap();

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match core.child.try_wait().unwrap() {
            Some(status) => {
                assert!(status.success(), "core exited with {status}");
                break;
            }
            None if std::time::Instant::now() > deadline => {
                panic!("core did not exit on EOF");
            }
            None => std::thread::sleep(std::time::Duration::from_millis(20)),
        }
    }
}
