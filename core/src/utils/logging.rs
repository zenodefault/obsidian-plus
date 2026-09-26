//! Local, privacy-preserving logging to stderr.
//!
//! Never log note text, memory contents or prompts (PLAN.md §97): callers pass
//! structured context (`component`, `request_id`, `operation_id`, `error`) and
//! a short message, never full payloads.

use serde_json::json;
use std::io::Write;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Debug = 0,
    Info = 1,
    Warn = 2,
    Error = 3,
}

static MIN_LEVEL: AtomicU8 = AtomicU8::new(0);
static PROCESS_START: OnceLock<SystemTime> = OnceLock::new();

/// Initialize the logger; severity below `min` is dropped. Returns false if
/// already initialized.
pub fn init(min: Level) -> bool {
    PROCESS_START.get_or_init(SystemTime::now);
    MIN_LEVEL
        .compare_exchange(0, min as u8, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

/// Log a structured event to stderr. Extra context belongs in `context` as
/// small scalar values — never note or memory content.
pub fn log(level: Level, component: &str, message: &str, context: serde_json::Value) {
    if (level as u8) < MIN_LEVEL.load(Ordering::SeqCst) {
        return;
    }
    let t = PROCESS_START.get().copied().unwrap_or_else(SystemTime::now);
    let secs = t
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    let line = json!({
        "t": secs,
        "level": format!("{level:?}").to_uppercase(),
        "component": component,
        "msg": message,
        "ctx": context,
    });
    let mut err = std::io::stderr().lock();
    let _ = writeln!(err, "{line}");
}

#[macro_export]
macro_rules! log_info {
    ($component:expr, $($arg:tt)*) => {
        $crate::utils::logging::log(
            $crate::utils::logging::Level::Info, $component,
            &format!($($arg)*), serde_json::json!({}))
    };
}

#[macro_export]
macro_rules! log_warn {
    ($component:expr, $ctx:expr, $($arg:tt)*) => {
        $crate::utils::logging::log(
            $crate::utils::logging::Level::Warn, $component,
            &format!($($arg)*), $ctx)
    };
}

#[macro_export]
macro_rules! log_error {
    ($component:expr, $ctx:expr, $($arg:tt)*) => {
        $crate::utils::logging::log(
            $crate::utils::logging::Level::Error, $component,
            &format!($($arg)*), $ctx)
    };
}
