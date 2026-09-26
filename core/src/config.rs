//! Runtime configuration.
//!
//! Every path is overridable so no part of the system depends on a hard-coded
//! location (PLAN.md §8). Defaults derive from `SOVEREIGN_DATA_DIR` or the
//! platform user-data directory.

use std::path::PathBuf;

/// Root of all core state. `<data_dir>/SovereignBrain/` per PLAN.md §8.
#[derive(Debug, Clone)]
pub struct Config {
    pub data_dir: PathBuf,
}

impl Config {
    /// Resolve configuration from the environment and CLI arguments.
    ///
    /// Precedence: `--data-dir <dir>` > `SOVEREIGN_DATA_DIR` env var >
    /// platform user-data directory. Returns an error when no directory can
    /// be determined.
    pub fn load() -> Result<Self, String> {
        let mut args = std::env::args().skip(1);
        let mut data_dir: Option<PathBuf> = None;
        while let Some(arg) = args.next() {
            if arg == "--data-dir" {
                match args.next() {
                    Some(dir) => data_dir = Some(PathBuf::from(dir)),
                    None => return Err("--data-dir requires a value".to_string()),
                }
            } else if arg.starts_with("--data-dir=") {
                data_dir = Some(PathBuf::from(arg.trim_start_matches("--data-dir=")));
            } else if arg == "--version" {
                println!("sovereign-core {}", crate::protocol::CORE_VERSION);
                std::process::exit(0);
            }
        }

        if data_dir.is_none() {
            data_dir = std::env::var("SOVEREIGN_DATA_DIR").ok().map(PathBuf::from);
        }
        if data_dir.is_none() {
            data_dir = dirs::config_dir().map(|p| p.join("SovereignBrain"));
        }

        data_dir
            .map(|data_dir| Self { data_dir })
            .ok_or_else(|| {
                "no data directory available: pass --data-dir or set SOVEREIGN_DATA_DIR".to_string()
            })
    }
}
