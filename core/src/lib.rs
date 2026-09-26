//! `server` — wires transport, dispatcher and lifecycle together.

pub mod chunking;
pub mod config;
pub mod dispatch;
pub mod indexing;
pub mod ipc;
pub mod jobs;
pub mod parser;
pub mod protocol;
pub mod server;
pub mod storage;
pub mod utils;
pub mod vault;
