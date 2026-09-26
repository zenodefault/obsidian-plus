//! Unit tests: envelope encode/decode, error mapping, round-trips.

use serde_json::json;

use sovereign_core::ipc::{read_envelope, write_envelope, FrameError, MAX_LINE_BYTES};
use sovereign_core::protocol::{Envelope, ErrorCode, RpcError};

fn env_request(id: &str, method: &str) -> Envelope {
    Envelope::request(id, method, json!({}))
}

#[test]
fn request_round_trip() {
    let env = env_request("req_1", "core.health");
    let mut buf = Vec::new();
    write_envelope(&mut buf, &env).unwrap();
    assert_eq!(buf.last(), Some(&b'\n'));

    let mut cursor = &buf[..];
    let parsed = read_envelope(&mut cursor).unwrap().unwrap();
    assert_eq!(parsed, env);
}

#[test]
fn notification_has_no_id() {
    let env = Envelope::notification("vault.sync.progress", json!({"done": 3}));
    assert!(env.id.is_none());

    let mut buf = Vec::new();
    write_envelope(&mut buf, &env).unwrap();
    let mut cursor = &buf[..];
    let parsed = read_envelope(&mut cursor).unwrap().unwrap();
    assert!(parsed.id.is_none());
    assert_eq!(parsed.method.as_deref(), Some("vault.sync.progress"));
}

#[test]
fn response_round_trip_success_and_error() {
    let ok = Envelope::success("req_2", json!({"status": "ok"}));
    let err = Envelope::failure(
        "req_3",
        RpcError::new(ErrorCode::MethodNotFound, "unknown method: nope")
            .with_request_id("req_3"),
    );

    let mut buf = Vec::new();
    write_envelope(&mut buf, &ok).unwrap();
    write_envelope(&mut buf, &err).unwrap();

    let mut cursor = &buf[..];
    let a = read_envelope(&mut cursor).unwrap().unwrap();
    let b = read_envelope(&mut cursor).unwrap().unwrap();
    assert_eq!(a, ok);
    assert_eq!(b, err);
    assert_eq!(b.error.as_ref().unwrap().code, ErrorCode::MethodNotFound);
}

#[test]
fn multiple_lines_are_independent_frames() {
    let mut buf = Vec::new();
    write_envelope(&mut buf, &env_request("a", "core.health")).unwrap();
    write_envelope(&mut buf, &env_request("b", "core.health")).unwrap();
    write_envelope(&mut buf, &env_request("c", "core.health")).unwrap();

    let mut cursor = &buf[..];
    for id in ["a", "b", "c"] {
        let env = read_envelope(&mut cursor).unwrap().unwrap();
        assert_eq!(env.id.as_deref(), Some(id));
    }
    assert!(read_envelope(&mut cursor).unwrap().is_none());
}

#[test]
fn invalid_json_maps_to_parse_error() {
    let mut cursor: &[u8] = b"{not json}\n";
    match read_envelope(&mut cursor) {
        Err(FrameError::Io(e)) => {
            assert!(e.to_string().contains("invalid JSON"));
        }
        other => panic!("expected parse error, got {other:?}"),
    }
}

#[test]
fn oversized_line_is_rejected_and_stream_stays_aligned() {
    let mut payload = Vec::new();
    payload.extend(std::iter::repeat(b'x').take(MAX_LINE_BYTES + 10));
    payload.push(b'\n');
    payload.extend_from_slice(b"{\"id\":\"next\"}\n");

    let mut cursor: &[u8] = &payload;
    match read_envelope(&mut cursor) {
        Err(FrameError::LineTooLarge) => {}
        other => panic!("expected LineTooLarge, got {other:?}"),
    }
    // Stream must be positioned at the next frame, not mid-garbage.
    let next = read_envelope(&mut cursor).unwrap();
    assert!(next.is_some(), "next frame after oversized line is readable");
}

#[test]
fn crlf_is_tolerated() {
    let mut cursor: &[u8] = b"{\"id\":\"r1\",\"method\":\"core.health\"}\r\n";
    let env = read_envelope(&mut cursor).unwrap().unwrap();
    assert_eq!(env.id.as_deref(), Some("r1"));
}

#[test]
fn empty_stream_is_clean_eof() {
    let mut cursor: &[u8] = b"";
    assert!(read_envelope(&mut cursor).unwrap().is_none());
}

#[test]
fn unknown_fields_are_rejected() {
    let mut cursor: &[u8] = b"{\"id\":\"x\",\"bogus\":1}\n";
    assert!(read_envelope(&mut cursor).is_err());
}
