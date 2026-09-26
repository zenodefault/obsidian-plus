//! Request dispatch: routes parsed envelopes to typed handlers and produces
//! response envelopes. Transport-agnostic so tests can drive it directly.

use crate::protocol::{
    Envelope, ErrorCode, HealthResult, RebuildParams, RebuildResult, RpcError, ShutdownParams,
    ShutdownResult, StateGetParams, SyncBatchParams, SyncBeginParams, SyncCommitParams,
    SyncFinishParams, SyncNoteParams, CORE_VERSION, PROTOCOL_VERSION,
};
use crate::vault::manager::{SyncManager, SyncNoteParams as NoteParamsView};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Outcome of invoking the dispatcher.
#[derive(Debug)]
pub enum Outcome {
    /// Send exactly this envelope back.
    Reply(Envelope),
    /// Nothing to send (notifications, `core.shutdown`).
    NoReply,
}

/// Shared state the dispatcher mutates on shutdown requests.
#[derive(Debug, Default)]
pub struct DispatchState {
    pub shutdown_requested: AtomicBool,
}

impl DispatchState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn is_shutting_down(&self) -> bool {
        self.shutdown_requested.load(Ordering::SeqCst)
    }
}

/// Dispatch one envelope, applying handler logic.
pub fn dispatch(env: &Envelope, state: &Arc<DispatchState>, vault: &Arc<SyncManager>) -> Outcome {
    let Some(method) = env.method.as_deref() else {
        return match &env.error {
            Some(err) => {
                Outcome::Reply(Envelope::failure(env.id.clone().unwrap_or_default(), err.clone()))
            }
            None => Outcome::NoReply,
        };
    };

    match method {
        "core.health" => handle_core_health(env),
        "core.shutdown" => handle_core_shutdown(env, state),
        "vault.sync.begin" => handle_vault_sync_begin(env, vault),
        "vault.sync.batch" => handle_vault_sync_batch(env, vault),
        "vault.sync.commit" => handle_vault_sync_commit(env, vault),
        "vault.sync.note" => handle_vault_sync_note(env, vault),
        "vault.sync.finish" => handle_vault_sync_finish(env, vault),
        "vault.state.get" => handle_vault_state_get(env, vault),
        "vault.rebuild" => handle_vault_rebuild(env, vault),
        _ => {
            if env.id.is_some() {
                let id = env.id.clone().unwrap_or_default();
                Outcome::Reply(Envelope::failure(
                    id.clone(),
                    method_not_found(method).with_request_id(id),
                ))
            } else {
                // Unknown notification: ignore silently per JSON-RPC.
                Outcome::NoReply
            }
        }
    }
}

fn method_not_found(method: &str) -> RpcError {
    RpcError::new(ErrorCode::MethodNotFound, format!("unknown method: {method}"))
        .with_details(serde_json::json!({ "method": method }))
}

fn ok(id: &str, value: Value) -> Outcome {
    Outcome::Reply(Envelope::success(id.to_string(), value))
}

fn invalid_params(id: &str, err: serde_json::Error) -> Outcome {
    Outcome::Reply(Envelope::failure(
        id.to_string(),
        RpcError::new(ErrorCode::InvalidParams, format!("invalid params: {err}"))
            .with_request_id(id),
    ))
}

fn handle_core_health(env: &Envelope) -> Outcome {
    let Some(id) = env.id.clone() else {
        return Outcome::NoReply;
    };
    let result = HealthResult {
        status: "ok".to_string(),
        version: CORE_VERSION.to_string(),
        protocol_version: PROTOCOL_VERSION,
        pid: std::process::id(),
    };
    ok(&id, serde_json::to_value(result).unwrap_or(Value::Null))
}

fn handle_core_shutdown(env: &Envelope, state: &Arc<DispatchState>) -> Outcome {
    let params = env.params.clone().unwrap_or(Value::Null);
    let Some(id) = env.id.clone() else {
        // Notification form: shut down without replying. Params unchecked.
        state.shutdown_requested.store(true, Ordering::SeqCst);
        return Outcome::NoReply;
    };
    if let Err(e) = serde_json::from_value::<ShutdownParams>(params) {
        return invalid_params(&id, e);
    }
    state.shutdown_requested.store(true, Ordering::SeqCst);
    let result = ShutdownResult { shutting_down: true };
    ok(&id, serde_json::to_value(result).unwrap_or(Value::Null))
}

fn handle_vault_sync_begin(env: &Envelope, vault: &Arc<SyncManager>) -> Outcome {
    let Some(id) = env.id.clone() else { return Outcome::NoReply };
    let params: SyncBeginParams = match serde_json::from_value(env.params.clone().unwrap_or(Value::Null)) {
        Ok(p) => p,
        Err(e) => return invalid_params(&id, e),
    };
    match vault.begin(params.rebuild) {
        Ok(result) => ok(&id, serde_json::to_value(result).unwrap_or(Value::Null)),
        Err(err) => Outcome::Reply(Envelope::failure(id.clone(), err.with_request_id(id))),
    }
}

fn handle_vault_sync_batch(env: &Envelope, vault: &Arc<SyncManager>) -> Outcome {
    let Some(id) = env.id.clone() else { return Outcome::NoReply };
    let params: SyncBatchParams = match serde_json::from_value(env.params.clone().unwrap_or(Value::Null)) {
        Ok(p) => p,
        Err(e) => return invalid_params(&id, e),
    };
    match vault.batch(&params) {
        Ok(received) => ok(
            &id,
            serde_json::json!({ "received": received }),
        ),
        Err(err) => Outcome::Reply(Envelope::failure(id.clone(), err.with_request_id(id))),
    }
}

fn handle_vault_sync_commit(env: &Envelope, vault: &Arc<SyncManager>) -> Outcome {
    let Some(id) = env.id.clone() else { return Outcome::NoReply };
    let params: SyncCommitParams = match serde_json::from_value(env.params.clone().unwrap_or(Value::Null)) {
        Ok(p) => p,
        Err(e) => return invalid_params(&id, e),
    };
    match vault.commit(&params.session_id) {
        Ok(result) => ok(&id, serde_json::to_value(result).unwrap_or(Value::Null)),
        Err(err) => Outcome::Reply(Envelope::failure(id.clone(), err.with_request_id(id))),
    }
}

fn handle_vault_sync_note(env: &Envelope, vault: &Arc<SyncManager>) -> Outcome {
    let Some(id) = env.id.clone() else { return Outcome::NoReply };
    let params: SyncNoteParams = match serde_json::from_value(env.params.clone().unwrap_or(Value::Null)) {
        Ok(p) => p,
        Err(e) => return invalid_params(&id, e),
    };
    let view = NoteParamsView {
        session_id: &params.session_id,
        note: &params.note,
    };
    match vault.note(&view) {
        Ok(result) => ok(&id, serde_json::to_value(result).unwrap_or(Value::Null)),
        Err(err) => Outcome::Reply(Envelope::failure(id.clone(), err.with_request_id(id))),
    }
}

fn handle_vault_sync_finish(env: &Envelope, vault: &Arc<SyncManager>) -> Outcome {
    let Some(id) = env.id.clone() else { return Outcome::NoReply };
    let params: SyncFinishParams = match serde_json::from_value(env.params.clone().unwrap_or(Value::Null)) {
        Ok(p) => p,
        Err(e) => return invalid_params(&id, e),
    };
    match vault.finish(&params.session_id) {
        Ok(result) => ok(&id, serde_json::to_value(result).unwrap_or(Value::Null)),
        Err(err) => Outcome::Reply(Envelope::failure(id.clone(), err.with_request_id(id))),
    }
}

fn handle_vault_state_get(env: &Envelope, vault: &Arc<SyncManager>) -> Outcome {
    let Some(id) = env.id.clone() else { return Outcome::NoReply };
    let params: StateGetParams = match serde_json::from_value(env.params.clone().unwrap_or(Value::Null)) {
        Ok(p) => p,
        Err(e) => return invalid_params(&id, e),
    };
    let result = vault.state_get(params.include_metadata);
    ok(&id, serde_json::to_value(result).unwrap_or(Value::Null))
}

fn handle_vault_rebuild(env: &Envelope, vault: &Arc<SyncManager>) -> Outcome {
    let Some(id) = env.id.clone() else { return Outcome::NoReply };
    if let Err(e) = serde_json::from_value::<RebuildParams>(env.params.clone().unwrap_or(Value::Null)) {
        return invalid_params(&id, e);
    }
    let cleared = vault.rebuild();
    let result = RebuildResult {
        cleared,
        message: "derived state cleared; next sync repopulates from the vault".to_string(),
    };
    ok(&id, serde_json::to_value(result).unwrap_or(Value::Null))
}
