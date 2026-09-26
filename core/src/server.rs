//! Server loop: reads envelopes from a reader, dispatches them, writes replies.
//!
//! Runs until EOF or a `core.shutdown` request. Blocking I/O only — the core is
//! a lightweight local process (PLAN.md §6, §92); no async runtime needed.

use crate::dispatch::{dispatch, DispatchState, Outcome};
use crate::ipc::{self, FrameError};
use crate::protocol::ErrorCode;
use crate::utils::logging::{self, Level};
use crate::vault::manager::SyncManager;
use std::io::{BufReader, Write};
use std::sync::Arc;

/// Serve requests until EOF or shutdown. Returns when the server should stop.
pub fn serve<R: std::io::Read, W: Write>(input: R, output: W, vault: Arc<SyncManager>) {
    let mut reader = BufReader::new(input);
    let mut writer = output;
    let state = DispatchState::new();

    logging::log(Level::Info, "server", "core listening on stdio", serde_json::json!({
        "pid": std::process::id(),
    }));

    loop {
        match ipc::read_envelope(&mut reader) {
            Ok(None) => {
                logging::log(Level::Info, "server", "stdin closed, exiting", serde_json::json!({}));
                return;
            }
            Ok(Some(env)) => {
                let id_for_log = env.id.clone().unwrap_or_default();
                let method_for_log = env.method.clone().unwrap_or_default();
                match dispatch(&env, &state, &vault) {
                    Outcome::Reply(reply) => {
                        if let Err(e) = ipc::write_envelope(&mut writer, &reply) {
                            logging::log(Level::Error, "server", "write failed", serde_json::json!({
                                "error": e.to_string(),
                            }));
                            return;
                        }
                    }
                    Outcome::NoReply => {}
                }
                if state.is_shutting_down() {
                    logging::log(Level::Info, "server", "shutdown requested", serde_json::json!({
                        "request_id": id_for_log,
                        "method": method_for_log,
                    }));
                    return;
                }
            }
            Err(FrameError::LineTooLarge) => {
                let _ = ipc::write_error(
                    &mut writer,
                    None,
                    ErrorCode::InvalidRequest,
                    "line too large",
                );
            }
            Err(FrameError::Io(e)) => {
                // Malformed JSON line: report and continue serving.
                let _ = ipc::write_error(
                    &mut writer,
                    None,
                    ErrorCode::ParseError,
                    &format!("could not parse request: {e}"),
                );
                // A pure read error (broken pipe) should not spin forever.
                if e.kind() != std::io::ErrorKind::InvalidData {
                    logging::log(Level::Error, "server", "read failed", serde_json::json!({
                        "error": e.to_string(),
                    }));
                    return;
                }
            }
        }
    }
}
