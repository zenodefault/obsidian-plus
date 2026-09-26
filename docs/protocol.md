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
| `brain.ask` | `{ query, limit?: usize 1..=20 }` | `{ answer, query_type, confidence, answer_mode, sources: [{note_id, note_path, chunk_id, heading_path, snippet, score}], memories: MemoryEntry[], contradictions: [...] }` |
| `agent.plan` | `{ request, link_target?, merge_paths?, merge_target? }` | `{ plan: { goal, files: [{path, action, content?, old_content?, new_path?}], rationale[] } }` — proposal only |
| `agent.create` | `{ request, files: [{path, action: create\|edit\|move, content?, old_content?, new_path?}] }` | `{ operation }` (approval_status `pending`) |
| `agent.approve` / `agent.reject` | `{ id }` | `{ operation }` |
| `agent.execute` | `{ id, current: [{path, hash}] }` | `{ operation, apply: [{path, action, content?, new_path?}] }` — version-checked (§64) |
| `agent.verify` | `{ id, applied: [{path, hash}] }` | `{ message }` |
| `agent.rollback` | `{ id, current: [{path, hash}] }` | `{ operation, apply: [reverse instructions] }` — §65 |
| `agent.tools` | `{}` | `{ tools: [{name, permission, decision: allow\|confirm\|denied, mutates}] }` |
| `operation.list` / `operation.get` | `{ limit? }` / `{ id }` | `{ operations }` / `{ operation }` |
| `activity.list` | `{ limit? }` | `{ events: AuditEvent[], chain_valid: bool }` |

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

## Reasoning (Part 7)

`brain.ask` implements the §56 pipeline: classify → retrieve → memory
retrieval → relationship expansion → context assembly → (local LLM) →
citation validation → answer.

- **Classification (§95)** is deterministic keyword matching into
  `simple_search | semantic_search | synthesis | comparison | temporal |
  contradiction | decision | relationship | agent_task`. Simple searches never
  trigger expensive reasoning (§94).
- **Context assembly** blends hybrid retrieval hits (§42, §44), accepted
  memories sharing query tokens (§49), claims and relationships of entities
  the query names, and open contradictions touching the query (all of them for
  contradiction analyses — §54: show both, never choose).
- **Generation** uses the local `ModelProvider.generate` (§75). Its prompt is
  hard-grounded: answer only from the evidence, cite note paths, and reply
  with the exact no-evidence sentence when evidence is missing. Retrieved
  content is framed as data, never as instructions (§67).
- **Citation validation (§58)**: a model answer survives only when it cites
  at least one source and every citation resolves to the retrieved context
  (full path, basename, wikilink or markdown link all resolve). Otherwise the
  deterministic evidence summary — whose every bullet cites its note — is
  returned instead.
- **Degradation (§76)**: with the default hash embedder (no generate
  capability) or a failing model, the evidence summary IS the answer. The
  result carries `answer_mode`:
  - `model` — LLM output, citations validated;
  - `evidence` — deterministic summary of retrieved context;
  - `agent` — vault-action routing message (agent_task queries never generate
    and never act; changes come only through Part 8's approval flow);
  - `no_evidence` — the §58 message: "I couldn't find evidence for this in the
    vault."
- **Confidence** is deterministic from retrieval quality (0.0 with no
  evidence, capped at 0.95).

## Agent & safety (Part 8)

Every state-changing action is a **structured operation** (§62): prepared →
previewed → explicitly approved → version-checked execution → verified →
rollback-able → audited. The full §59 pipeline, with the policy engine (§61)
enforcing it deterministically — the model never touches the permission path
(Rule 6, §67, Rule 7).

- **Policy (§61)**: reads/searches/memory-proposals are `allow`; vault
  create/modify/move and memory writes are `confirm` (approval of a previewed
  operation); `vault.delete` is `denied` outright — agent delete requests are
  refused at prepare time with `PERMISSION_DENIED` (§103: unauthorized
  state-changing actions = 0). There is no API to change the matrix.
- **Planner (§59)**: deterministic strategies (link suggestions, merges,
  missing-title metadata), each grounded in indexed state; ungrounded write
  intents are refused. Merges never delete sources (Rule 9). Planning never
  mutates anything.
- **Version safety (§64)**: the core never reads the vault (§89), so the
  plugin attests current path→hash pairs with `agent.execute`. Any mismatch
  with the prepare-time hashes aborts the WHOLE operation — no partial
  application — with `FILE_VERSION_CONFLICT`.
- **Rollback (§65)**: allowed only while every file still matches the
  operation's post-state (plugin attests again). Emits reverse instructions:
  edit → restore pre-state content, create → delete the created file, move →
  move back. Newer manual changes are never overwritten.
- **Verification**: after applying, the plugin reports post-apply hashes via
  `agent.verify`; mismatches are recorded as `operation.verify_failed` in the
  audit and surfaced to the caller.
- **Audit (§66)**: hash-chained append-only log (actor, reason, target,
  approval, result). `activity.list` returns the trail plus `chain_valid`; a
  tampered row breaks verification (security test §99).
- **Apply boundary**: `agent.execute` returns per-file instructions; the
  **plugin** applies them through Obsidian's vault API and reports hashes
  back. The core never writes to the vault (§4.2).

## Hardening & security (Part 9)

The test suite (`core/tests/hardening_test.rs`) is the executable security
case — every guarantee below is enforced by a test that fails loudly on
regression (§96, §99):

- **Network isolation (§96)**: static scans assert the core source and
  `Cargo.toml` contain no HTTP/TCP clients or telemetry dependencies; the
  only sanctioned subprocess spawn is the user-configured embedding binary.
- **Corrupted database (§99)**: a garbage `brain.db` fails at any open stage
  (pragmas included), is quarantined as `brain.db.corrupt-<ts>` (never
  silently deleted, WAL/SHM sidecars removed) and the store rebuilds itself;
  transient lock/busy errors are never classified as corruption.
- **Corrupted vector data (§99)**: truncated/wrong-dimension embedding blobs
  never panic retrieval; cosine treats mismatched dimensions as 0.0 and FTS
  keeps answering.
- **Prompt injection (§67)**: notes containing injected instructions remain
  *content*; a model that "obeys" them loses its answer to §58 citation
  validation, the prompt builder keeps instructions strictly before the
  evidence data channel, and permission decisions stay outside the model.
- **Permission escalation (§99)**: unapproved execution → `PERMISSION_DENIED`,
  tampered hashes → `FILE_VERSION_CONFLICT`, deletes refused at prepare time;
  malformed/oversized/unknown-field requests all fail closed with typed codes.
- **Model failure (§76)**: broken model configs degrade search to lexical
  (no breakdown) and answers to the evidence summary; the CLI provider's
  output parser is strict — diagnostics from a misbehaving binary can never
  masquerade as embeddings; model calls have no write path to the vault.
- **Resource limits (§91, §92)**: 10 MB stdin cap rejects oversized lines
  without buffering and the server keeps serving; 200-note indexing and
  bounded retrieval complete within generous time bounds.

## Framing constants

- `PROTOCOL_VERSION: 1` — bump on breaking changes; both sides reject mismatches loudly.
- `CORE_VERSION` — core semantic version, reported by `core.health`.
