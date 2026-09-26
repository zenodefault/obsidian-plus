#!/usr/bin/env bash
# Test everything: Rust core, then TypeScript plugin.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Testing core (cargo test)"
(cd core && cargo test)

echo "==> Testing plugin (npm test)"
(cd plugin && npm test)

echo "==> All tests passed."
