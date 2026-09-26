#!/usr/bin/env bash
# Build everything: Rust core, then TypeScript plugin.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Building core (cargo)"
(cd core && cargo build --release)

echo "==> Building plugin (npm)"
(cd plugin && npm run build)

echo "==> Done. Core binary: core/target/release/sovereign-core"
