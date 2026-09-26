# Sovereign Protocol v1

Wire format between the Obsidian plugin and the Sovereign Core.
Shared contract, validated by fixtures in `schemas/protocol/fixtures.jsonl`
(used by both the Rust and TypeScript test suites).

## Transport

- Newline-delimited JSON (NDJSON) over the core process's stdin/stdout.
- One message per line, UTF-8, terminated by `\n` (`\r\n` tolerated).
- Maximum line size: 10 MB (`MAX_LINE_BYTES`). Larger lines are rejected
  without buffering.
- No network sockets. The core never listens, never connects out.

## Message shape

```jsonc
// Request / notification
{ "id": "req_123", "method": "core.health", "params": {} }
{ "method": "core.shutdown", "params": {} }        // notification: no id

// Success response
{ "id": "req_123", "result": { "status": "ok", "version": "0.1.0", "protocol_version": 1, "pid": 4242 } }

// Error response
{ "id": "req_124", "error": { "code": "METHOD_NOT_FOUND", "message": "unknown method: brain.ask", "details": {}, "request_id": "req_124" } }
```

Rules:

- `id` is a string when present; responses echo the request's `id`.
- Unknown fields are rejected (`deny_unknown_fields` / strict parsing).
- Responses carry exactly one of `result` or `error`.
- Errors carry a stable `code` (see below), human-readable `message`,
  optional structured `details`, and `request_id` when known.

## Error codes

| Code | Meaning |
|------|---------|
| `PARSE_ERROR` | Line was not valid JSON. Server continues serving. |
| `INVALID_REQUEST` | Structurally invalid message (e.g. oversized line). |
| `METHOD_NOT_FOUND` | Unknown method name. |
| `INVALID_PARAMS` | Params failed schema validation. |
| `INTERNAL` | Unexpected core-side failure. |
| `FILE_VERSION_CONFLICT` | *(reserved, Part 8)* file changed since an operation was prepared. |
| `PERMISSION_DENIED` | *(reserved, Part 8)* policy rejected the action. |

## Methods (v1)

| Method | Params | Result |
|--------|--------|--------|
| `core.health` | `{}` | `{ status, version, protocol_version, pid }` |
| `core.shutdown` | `{}` | `{ shutting_down: true }` — core replies, then exits 0 |
| `vault.sync.begin` | `{ rebuild?: bool }` | `{ session_id, rebuild }` |
| `vault.sync.batch` | `{ session_id, notes: [{path, hash, mtime, size}] }` | `{ received }` |
| `vault.sync.commit` | `{ session_id }` | `{ added, modified, renamed: [{from,to}], deleted, to_fetch, applied }` |
| `vault.sync.note` | `{ session_id, path, hash, mtime, size, content }` | `{ path, note_id, updated }` |
| `vault.sync.finish` | `{ session_id }` | `{ total_notes, persisted }` |
| `vault.state.get` | `{ include_metadata?: bool }` | `{ total_notes, notes: [{note_id, path, content_hash, title?, tags?}] }` |
| `vault.rebuild` | `{}` | `{ cleared, message }` |
| `search.query` | `{ query, limit?: usize ≤ 100 }` | `{ hits: [{note_id, note_path, chunk_id, heading_path, snippet, score}], total_notes }` |
| `health.summary` | `{}` | `{ total_notes, total_chunks, total_entities, total_claims, broken_links[], orphan_notes[], duplicate_candidates[], failed_jobs, pending_jobs }` |
| `models.status` | `{}` | `{ provider, model_path?, binary_path?, dimension, chunks_total, chunks_embedded, chunks_pending, validation_error? }` |
| `memory.list` | `{ status?: string }` | `{ memories: MemoryEntry[] }` |
| `memory.accept` / `memory.reject` | `{ id }` | `{ memory: MemoryEntry }` |
| `memory.update` | `{ id, content?, type? }` | `{ memory: MemoryEntry }` |
| `memory.supersede` | `{ id, content, type? }` | `{ memory: MemoryEntry }` |
| `contradiction.list` | `{}` | `{ contradictions: [{id, kind, status, claim_a, claim_b, created_at}] }` |
| `contradiction.resolve` | `{ id, resolution: keep_both\|mark_later_current\|ignore }` | `{ message }` |

Lifecycle rules:

- Core exits on stdin EOF (orphan protection: if the plugin dies, the core dies).
- Core exits after answering `core.shutdown`.
- Unknown notifications (no `id`) are silently ignored, per JSON-RPC convention.
- Malformed lines produce a `PARSE_ERROR` reply and **do not** terminate the server.

## Vault sync flow (Part 2)

```text
plugin                          core
  │ vault.sync.begin ──────────▶ open session (wipe state if rebuild)
  │ vault.sync.batch × n ──────▶ record inventory (path, hash, mtime, size)
  │ vault.sync.commit ─────────▶ diff vs state, detect renames, apply deletes
  │◀───── { added, modified, renamed, deleted, to_fetch }
  │ vault.sync.note × k ───────▶ verify hash, extract metadata, assign note_id
  │ vault.sync.finish ─────────▶ validate completeness, persist atomically
```

Note identity: `note_id` is a UUID minted on first content upload and kept
forever. A rename (same content hash at a new path, with the old path gone)
carries identity over and needs **no** re-upload. The core never reads or
writes the vault; the plugin is the sole source of content (§89).

## Search (Part 3)

`search.query` is the deterministic fast path (§94): FTS5 keyword retrieval
over chunk-level content with bm25 ranking and highlighted snippets. Query
syntax characters in user input are escaped — the query is literal text, never
an FTS operator expression (§67 hygiene). `score` is higher-is-better.
Semantic/vector retrieval merges into the same response shape in Part 5.

## Knowledge & health (Part 4)

Extraction is deterministic (§7): entities from tags/wikilinks/titles, typed
claims (§48) from sentence markers with byte-offset provenance, relationships
from `uses`/`interested_in`-style link sentences. Re-indexing a note replaces
its knowledge provenance-scoped — counts stay exact. Deleting a note deletes
its claims (no source, no claim, §52).

`health.summary` is detection-only (§68): broken links, orphans and exact
duplicate candidates are reported and never acted upon (§69: never
auto-delete).

## Models & hybrid search (Part 5)

The `ModelProvider` abstraction (§75) has two local implementations: `hash`
(default — deterministic hashing embedder, no model files needed) and `cli`
(a user-supplied llama.cpp-style binary with a user-supplied GGUF model —
§74: validated up front, never downloaded). All processing is local (§96).

`search.query` now runs hybrid ranking (§42, §44): lexical (FTS bm25,
weight 0.5) + semantic (embedding cosine, 0.35) + entity overlap (0.15),
merged deterministically. Hybrid hits carry `score_breakdown`; when the model
is unavailable the response degrades to lexical-only hits **without**
`score_breakdown` and search keeps working (§76).

## Memory (Part 6)

Memory candidates come only from DECISION/PREFERENCE/GOAL/EXPERIENCE claims
(§50); hypotheses and questions never become memories (§51). Every memory
carries provenance (§52): source note, claim, verbatim excerpt. First-person
claims are attributed to the `user` subject so §54 can catch preference
conflicts across notes; detection is conservative (same subject + same type +
opposite polarity) and shows both sources — never auto-chooses (§54).
Deletion of source notes marks memories `stale` for review, never deletes
them (§55). Accepted memories survive re-indexing (§90).

## Framing constants

- `PROTOCOL_VERSION: 1` — bump on breaking changes; both sides reject mismatches loudly.
- `CORE_VERSION` — core semantic version, reported by `core.health`.
