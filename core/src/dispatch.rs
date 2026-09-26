//! Request dispatch: routes parsed envelopes to typed handlers and produces
//! response envelopes. Transport-agnostic so tests can drive it directly.

use crate::protocol::{
    Envelope, ErrorCode, HealthResult, ShutdownParams, ShutdownResult, CORE_VERSION,
    PROTOCOL_VERSION,
};
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
pub fn dispatch(env: &Envelope, state: &Arc<DispatchState>) -> Outcome {
    let Some(method) = env.method.as_deref() else {
        return match &env.error {
            Some(err) => Outcome::Reply(Envelope::failure(env.id.clone().unwrap_or_default(), err.clone())),
            None => Outcome::NoReply,
        };
    };

    match method {
        "core.health" => handle_core_health(env),
        "core.shutdown" => handle_core_shutdown(env, state),
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

fn method_not_found(method: &str) -> crate::protocol::RpcError {
    crate::protocol::RpcError::new(
        ErrorCode::MethodNotFound,
        format!("unknown method: {method}"),
    )
    .with_details(serde_json::json!({ "method": method }))
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
    Outcome::Reply(Envelope::success(
        id,
        serde_json::to_value(result).unwrap_or(Value::Null),
    ))
}

fn handle_core_shutdown(env: &Envelope, state: &Arc<DispatchState>) -> Outcome {
    // Validate params strictly: unknown fields are rejected, not ignored.
    let params = env.params.clone().unwrap_or(Value::Null);
    if let Err(e) = serde_json::from_value::<ShutdownParams>(params) {
        let Some(id) = env.id.clone() else {
            return Outcome::NoReply;
        };
        return Outcome::Reply(Envelope::failure(
            id.clone(),
            crate::protocol::RpcError::new(ErrorCode::InvalidParams, format!("invalid params: {e}"))
                .with_request_id(id),
        ));
    }

    if let Some(id) = env.id.clone() {
        let result = ShutdownResult {
            shutting_down: true,
        };
        state.shutdown_requested.store(true, Ordering::SeqCst);
        return Outcome::Reply(Envelope::success(
            id,
            serde_json::to_value(result).unwrap_or(Value::Null),
        ));
    }
    // Notification form: shut down without replying.
    state.shutdown_requested.store(true, Ordering::SeqCst);
    Outcome::NoReply
}


