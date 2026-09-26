//! Sovereign Core entry point.
//!
//! A local process speaking newline-delimited JSON-RPC over stdin/stdout.
//! It never touches the network and never writes to the Obsidian vault.

use sovereign_core::config::Config;
use sovereign_core::server;
use sovereign_core::utils::logging::{self, Level};

fn main() {
    logging::init(Level::Info);

    let config = match Config::load() {
        Ok(c) => c,
        Err(e) => {
            logging::log(Level::Error, "main", "configuration error", serde_json::json!({
                "error": e,
            }));
            std::process::exit(2);
        }
    };

    logging::log(Level::Info, "main", "core starting", serde_json::json!({
        "data_dir": config.data_dir.to_string_lossy(),
    }));

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    server::serve(stdin.lock(), stdout.lock());

    logging::log(Level::Info, "main", "core stopped", serde_json::json!({}));
}
