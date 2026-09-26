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

## Framing constants

- `PROTOCOL_VERSION: 1` — bump on breaking changes; both sides reject mismatches loudly.
- `CORE_VERSION` — core semantic version, reported by `core.health`.
