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

        let bin = env!("CARGO_BIN_EXE_sovereign-core");
        let child = Command::new(bin)
            .arg("--data-dir")
            .arg(&tmp)
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
