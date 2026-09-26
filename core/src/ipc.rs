//! Newline-delimited JSON framing over any reader/writer (PLAN.md §5).
//!
//! One `Envelope` per line; lines above the size limit are rejected without
//! buffering them.

use crate::protocol::{Envelope, ErrorCode, RpcError};
use serde_json::Value;
use std::io::{BufRead, Write};

/// Maximum accepted line size: 10 MB — guards against runaway sends.
pub const MAX_LINE_BYTES: usize = 10 * 1024 * 1024;

pub type FrameResult<T> = Result<T, FrameError>;

/// Non-protocol failures that should terminate the read loop.
#[derive(Debug)]
pub enum FrameError {
    /// Line exceeded [`MAX_LINE_BYTES`]; the rest of the line was drained.
    LineTooLarge,
    Io(std::io::Error),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::LineTooLarge => write!(f, "line exceeds {MAX_LINE_BYTES} bytes"),
            FrameError::Io(e) => write!(f, "io error: {e}"),
        }
    }
}

/// Read one line and parse it into an [`Envelope`].
///
/// - `Ok(None)` — clean end of stream.
/// - `Ok(Some(_))` — a well-formed envelope.
/// - `Err(FrameError::LineTooLarge)` — oversized line; caller should reply
///   with an error and continue.
pub fn read_envelope(reader: &mut impl BufRead) -> FrameResult<Option<Envelope>> {
    let mut buf = Vec::with_capacity(1024);
    let oversized = read_line_capped(reader, &mut buf).map_err(FrameError::Io)?;

    if oversized {
        return Err(FrameError::LineTooLarge);
    }
    if buf.is_empty() {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&buf);
    match serde_json::from_str::<Envelope>(&text) {
        Ok(env) => Ok(Some(env)),
        // InvalidData marks a malformed *line* (recoverable) as opposed to a
        // real read failure, which callers treat as fatal.
        Err(e) => Err(FrameError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("invalid JSON: {e}"),
        ))),
    }
}

/// Write an envelope as one JSON line and flush.
pub fn write_envelope(writer: &mut impl Write, envelope: &Envelope) -> std::io::Result<()> {
    let mut line = serde_json::to_string(envelope)
        .map_err(std::io::Error::other)?
        .into_bytes();
    line.push(b'\n');
    writer.write_all(&line)?;
    writer.flush()
}

/// Send a typed error for `request_id` (or a null-id error when unknown).
pub fn write_error(
    writer: &mut impl Write,
    request_id: Option<String>,
    code: ErrorCode,
    message: &str,
) -> std::io::Result<()> {
    let mut error = RpcError::new(code, message);
    error.request_id = request_id.clone();
    let id = request_id.unwrap_or_default();
    write_envelope(writer, &Envelope::failure(id, error))
}

/// Read exactly one line up to the cap. Returns `true` when the cap was hit.
fn read_line_capped(
    reader: &mut impl BufRead,
    buf: &mut Vec<u8>,
) -> Result<bool, std::io::Error> {
    let mut cap_hit = false;
    loop {
        let mut byte = [0u8; 1];
        let n = reader.read(&mut byte)?;
        if n == 0 {
            // EOF: a non-empty remainder is a final unterminated line.
            return Ok(cap_hit);
        }
        match byte[0] {
            b'\n' => return Ok(cap_hit),
            b'\r' => {}
            b if buf.len() < MAX_LINE_BYTES => buf.push(b),
            _ => cap_hit = true,
        }
    }
}

/// Build the standard `LINE_TOO_LARGE` error detail payload.
pub fn line_too_large_details() -> Value {
    serde_json::json!({ "limit_bytes": MAX_LINE_BYTES })
}
