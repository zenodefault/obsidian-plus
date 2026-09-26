//! Unit tests for the dispatcher: known methods, unknown methods, notifications.

use serde_json::json;
use sovereign_core::dispatch::{dispatch, DispatchState, Outcome};
use sovereign_core::protocol::{Envelope, ErrorCode, PROTOCOL_VERSION};
use sovereign_core::vault::manager::SyncManager;

/// Fresh manager over a unique throwaway data dir (tests run in parallel).
fn vault() -> std::sync::Arc<SyncManager> {
    let dir = std::env::temp_dir().join(format!(
        "sv-dispatch-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos()
    ));
    std::fs::create_dir_all(&dir).ok();
    SyncManager::new(&dir)
}

#[test]
fn health_returns_expected_shape() {
    let state = DispatchState::new();
    let env = Envelope::request("r1", "core.health", json!({}));
    match dispatch(&env, &state, &vault()) {
        Outcome::Reply(reply) => {
            assert_eq!(reply.id.as_deref(), Some("r1"));
            assert!(reply.error.is_none());
            let result = reply.result.expect("health result");
            assert_eq!(result["status"], "ok");
            assert_eq!(result["protocol_version"], PROTOCOL_VERSION);
            assert!(result["version"].is_string());
            assert!(result["pid"].is_u64());
        }
        other => panic!("expected reply, got {other:?}"),
    }
}

#[test]
fn shutdown_request_replies_then_sets_flag() {
    let state = DispatchState::new();
    let env = Envelope::request("r2", "core.shutdown", json!({}));
    assert!(matches!(dispatch(&env, &state, &vault()), Outcome::Reply(_)));
    assert!(state.is_shutting_down());
}

#[test]
fn shutdown_notification_sets_flag_without_reply() {
    let state = DispatchState::new();
    let env = Envelope::notification("core.shutdown", json!({}));
    assert!(matches!(dispatch(&env, &state, &vault()), Outcome::NoReply));
    assert!(state.is_shutting_down());
}

#[test]
fn unknown_method_yields_method_not_found() {
    let state = DispatchState::new();
    let env = Envelope::request("r3", "brain.ask", json!({}));
    match dispatch(&env, &state, &vault()) {
        Outcome::Reply(reply) => {
            let err = reply.error.expect("error object");
            assert_eq!(err.code, ErrorCode::MethodNotFound);
            assert_eq!(err.request_id.as_deref(), Some("r3"));
            assert!(err.message.contains("brain.ask"));
        }
        other => panic!("expected reply, got {other:?}"),
    }
}

#[test]
fn unknown_notification_is_silently_ignored() {
    let state = DispatchState::new();
    let env = Envelope::notification("no.such.method", json!({}));
    assert!(matches!(dispatch(&env, &state, &vault()), Outcome::NoReply));
    assert!(!state.is_shutting_down());
}

#[test]
fn health_params_are_ignored_but_shutdown_validates_params() {
    let state = DispatchState::new();
    // Health ignores params entirely.
    let env = Envelope::request("r4", "core.health", json!({"anything": true}));
    assert!(matches!(dispatch(&env, &state, &vault()), Outcome::Reply(_)));

    // Shutdown rejects unknown params instead of silently accepting them.
    let bad = Envelope::request("r5", "core.shutdown", json!({"force": true}));
    match dispatch(&bad, &state, &vault()) {
        Outcome::Reply(reply) => {
            let err = reply.error.expect("error object");
            assert_eq!(err.code, ErrorCode::InvalidParams);
        }
        other => panic!("expected reply, got {other:?}"),
    }
}

#[test]
fn dispatch_tolerates_error_only_envelopes() {
    let state = DispatchState::new();
    let env = Envelope::request("r6", "core.health", json!({}));
    // Malformed inbound envelope (error-only) must not panic the dispatcher.
    let mut weird = env.clone();
    weird.method = None;
    assert!(matches!(dispatch(&weird, &state, &vault()), Outcome::NoReply));
}

#[test]
fn vault_methods_route_and_error_with_request_id() {
    let state = DispatchState::new();
    // Unknown session → INVALID_PARAMS carrying the request id.
    let env = Envelope::request("v1", "vault.sync.commit", json!({"session_id": "nope"}));
    match dispatch(&env, &state, &vault()) {
        Outcome::Reply(reply) => {
            let err = reply.error.expect("error object");
            assert_eq!(err.code, ErrorCode::InvalidParams);
            assert_eq!(err.request_id.as_deref(), Some("v1"));
        }
        other => panic!("expected reply, got {other:?}"),
    }

    // Structurally invalid params (wrong types) → INVALID_PARAMS.
    let env = Envelope::request("v2", "vault.sync.batch", json!({"session_id": 42}));
    match dispatch(&env, &state, &vault()) {
        Outcome::Reply(reply) => {
            assert_eq!(reply.error.expect("error").code, ErrorCode::InvalidParams);
        }
        other => panic!("expected reply, got {other:?}"),
    }

    // Rebuild replies with cleared=true.
    let env = Envelope::request("v3", "vault.rebuild", json!({}));
    match dispatch(&env, &state, &vault()) {
        Outcome::Reply(reply) => {
            assert_eq!(reply.result.expect("result")["cleared"], true);
        }
        other => panic!("expected reply, got {other:?}"),
    }
}
