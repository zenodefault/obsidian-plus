//! Envelope, requests, responses and typed errors for the local JSON-RPC protocol.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Protocol and core version constants.
pub mod version;

pub use version::{CORE_VERSION, PROTOCOL_VERSION};

/// A single inbound or outbound message on the stdio stream.
///
/// Requests and notifications share this shape; notifications carry no `id`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    /// Present for requests and responses, absent for notifications.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Method name for requests/notifications; absent on responses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    /// Method parameters (request) or result payload (response).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
    /// Successful result payload (responses only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    /// Error object (responses only). Mutually exclusive with `result`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl Envelope {
    pub fn request(id: impl Into<String>, method: impl Into<String>, params: Value) -> Self {
        Self {
            id: Some(id.into()),
            method: Some(method.into()),
            params: Some(params),
            result: None,
            error: None,
        }
    }

    pub fn notification(method: impl Into<String>, params: Value) -> Self {
        Self {
            id: None,
            method: Some(method.into()),
            params: Some(params),
            result: None,
            error: None,
        }
    }

    pub fn success(id: impl Into<String>, result: Value) -> Self {
        Self {
            id: Some(id.into()),
            method: None,
            params: None,
            result: Some(result),
            error: None,
        }
    }

    pub fn failure(id: impl Into<String>, error: RpcError) -> Self {
        Self {
            id: Some(id.into()),
            method: None,
            params: None,
            result: None,
            error: Some(error),
        }
    }
}

/// Typed error object, mirroring PLAN.md §98.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RpcError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(default)]
    pub details: Value,
    /// Echoed from the failing request when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

impl RpcError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: Value::Null,
            request_id: None,
        }
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = details;
        self
    }

    pub fn with_request_id(mut self, request_id: impl Into<String>) -> Self {
        self.request_id = Some(request_id.into());
        self
    }
}

/// Stable, typed error codes. UI layers translate these to human messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    ParseError,
    InvalidRequest,
    MethodNotFound,
    InvalidParams,
    Internal,
    #[serde(rename = "FILE_VERSION_CONFLICT")]
    FileVersionConflict,
    #[serde(rename = "PERMISSION_DENIED")]
    PermissionDenied,
}

/// Result payload of `core.health`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct HealthResult {
    pub status: String,
    pub version: String,
    pub protocol_version: u32,
    pub pid: u32,
}

/// Params of `core.shutdown` (currently empty; reserved for future flags).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, default)]
pub struct ShutdownParams {}

/// Result payload of `core.shutdown`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ShutdownResult {
    pub shutting_down: bool,
}

// Vault sync protocol types re-exported for dispatch convenience.
pub use crate::vault::types::{
    RebuildParams, RebuildResult, StateGetParams, SyncBatchParams, SyncBeginParams,
    SyncCommitParams, SyncFinishParams, SyncNote, SyncNoteParams,
};
