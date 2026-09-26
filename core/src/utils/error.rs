//! Error handling utilities and common aliases.

use std::fmt;

/// Convenience alias for fallible core operations.
pub type Result<T> = std::result::Result<T, CoreError>;

/// Top-level core error.
#[derive(Debug)]
pub enum CoreError {
    Io(std::io::Error),
    Serde(serde_json::Error),
    Protocol(String),
}

impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CoreError::Io(e) => write!(f, "io error: {e}"),
            CoreError::Serde(e) => write!(f, "serialization error: {e}"),
            CoreError::Protocol(msg) => write!(f, "protocol error: {msg}"),
        }
    }
}

impl std::error::Error for CoreError {}

impl From<std::io::Error> for CoreError {
    fn from(e: std::io::Error) -> Self {
        CoreError::Io(e)
    }
}

impl From<serde_json::Error> for CoreError {
    fn from(e: serde_json::Error) -> Self {
        CoreError::Serde(e)
    }
}
