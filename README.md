# Sovereign Second Brain

A completely local, offline-capable intelligence layer built around an Obsidian vault.

> Obsidian stores the user's knowledge, the local Sovereign Core understands and
> remembers it, and the user remains the final authority over every memory and action.

Zero cloud · zero telemetry · zero accounts · zero remote AI APIs.

## Components

- `core/` — Sovereign Core (Rust): local process speaking newline-delimited JSON-RPC over stdin/stdout. Owns storage, indexing, knowledge, memory, reasoning, agent, policy, audit.
- `plugin/` — Obsidian plugin (TypeScript): launches the core as a child process, bridges vault events, renders intelligence. The core never writes to the vault directly.
- `schemas/` — protocol contracts and fixtures shared by both sides.
- `docs/` — architecture, protocol and security documentation.

## Status

Implementation follows the workstream order in [PLAN.md](PLAN.md) (UI/UX workstreams excluded).

| Part | Scope | Status |
|------|-------|--------|
| 1 — Foundation | repo skeleton, typed protocol, IPC, core lifecycle, plugin daemon client | ✅ |
| 2 — Vault Bridge | vault sync, hashing, note identity, rebuild | ✅ |
| 3 — Storage & Index | SQLite, FTS5, chunking, search, job queue | ✅ (vector search in Part 5) |
| 4 — Knowledge | entities, claims, relationships, provenance | ✅ (AI refinement in Part 7) |
| 5 — Model Runtime | ModelProvider, hash/CLI embedders, hybrid retrieval | ✅ (GGUF embeddings via user-supplied binary) |
| 6 — Memory | memory lifecycle, contradictions, stale detection | ✅ |
| 7 — Reasoning | classification, context assembly, `brain.ask`, citation validation | ✅ (LLM refinement via user-supplied local model) |
| 8 — Agent & Safety | planner, policy, operations, approval, rollback, audit | ✅ |
| 9 — Hardening | security tests, benchmarks | ⬜ |

## Building

```bash
./scripts/build.sh   # builds core (cargo) and plugin (esbuild)
./scripts/test.sh    # runs core and plugin test suites
```

Requirements: Rust (stable, via rustup), Node.js ≥ 20.

## Privacy

The system contains no cloud clients, no telemetry, no accounts and no network
code paths. Runtime works fully offline; the only communication is local IPC
between the plugin and the core process. See `docs/protocol.md` and `PLAN.md`.
