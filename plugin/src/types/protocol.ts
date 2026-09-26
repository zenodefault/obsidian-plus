/**
 * Wire types for the Sovereign protocol v1 (docs/protocol.md).
 *
 * Mirrors the Rust types in core/src/protocol.rs. The shared fixtures in
 * schemas/protocol/fixtures.jsonl keep both sides in lockstep — do not edit
 * one side without the other.
 */

export const PROTOCOL_VERSION = 1;

/** Stable error codes. UI layers translate these into human messages. */
export type ErrorCode =
  | "PARSE_ERROR"
  | "INVALID_REQUEST"
  | "METHOD_NOT_FOUND"
  | "INVALID_PARAMS"
  | "INTERNAL"
  | "FILE_VERSION_CONFLICT"
  | "PERMISSION_DENIED";

/** Typed error object (PLAN.md §98). */
export interface RpcError {
  code: ErrorCode;
  message: string;
  details?: unknown;
  request_id?: string;
}

/** Result payload of `core.health`. */
export interface HealthResult {
  status: string;
  version: string;
  protocol_version: number;
  pid: number;
}

/** Result payload of `core.shutdown`. */
export interface ShutdownResult {
  shutting_down: boolean;
}

/**
 * A single message on the stdio stream. Requests and notifications share this
 * shape; responses carry `result` or `error`.
 */
export interface Envelope {
  id?: string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: RpcError;
}

/** Thrown (or rejected) client-side when a request fails or times out. */
export class RpcErrorImpl extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** Type guard helpers for discriminating responses. */
export function isSuccessfulResponse(env: Envelope): env is Envelope & { id: string; result: unknown } {
  return env.id !== undefined && env.result !== undefined && env.error === undefined;
}

export function isErrorResponse(env: Envelope): env is Envelope & { id: string; error: RpcError } {
  return env.id !== undefined && env.error !== undefined;
}

// ---------------------------------------------------------------------------
// UI & State Data Models (Workstream 8)
// ---------------------------------------------------------------------------

export type ConfidenceLevel = "high" | "medium" | "low";

/** Ask View Models */
export interface AskSource {
  path: string;
  title: string;
  excerpt: string;
  score?: number;
}

export interface AskMemoryRef {
  id: string;
  statement: string;
  type: MemoryType;
}

export interface AskConflictRef {
  earlier: string;
  earlier_source: string;
  later: string;
  later_source: string;
  interpretation: string;
}

export interface AskQueryResult {
  query: string;
  answer: string;
  confidence: ConfidenceLevel;
  sources: AskSource[];
  memories: AskMemoryRef[];
  conflicts?: AskConflictRef[];
}

/** Note Context Models */
export interface CurrentNoteContext {
  path: string;
  title: string;
  related_notes_count: number;
  memories_count: number;
  potential_connections_count: number;
  contradictions_count: number;
  similar_notes: string[];
}

/** Memory Models */
export type MemoryStatus = "pending" | "accepted" | "superseded" | "rejected";
export type MemoryType = "goal" | "preference" | "decision" | "experience" | "project";

export interface MemoryItem {
  id: string;
  statement: string;
  type: MemoryType;
  status: MemoryStatus;
  source_path: string;
  confidence: ConfidenceLevel;
  created_at: string;
  related_topics?: string[];
}

/** Actions & Diff Models */
export type OperationStatus = "proposed" | "approved" | "rejected" | "applied";

export interface DiffLine {
  type: "add" | "delete" | "context";
  text: string;
}

export interface FileDiff {
  file_path: string;
  diff_lines: DiffLine[];
}

export interface ProposedOperation {
  id: string;
  title: string;
  why: string;
  risk: "low" | "medium" | "high";
  status: OperationStatus;
  affected_files: string[];
  diffs: FileDiff[];
}

/** Brain Health & Activity Models */
export interface BrainHealthMetrics {
  indexed_notes: number;
  pending_memories: number;
  potential_contradictions: number;
  stale_knowledge: number;
  duplicate_notes: number;
  broken_links: number;
}

export interface AuditActivityItem {
  id: string;
  timestamp: string;
  title: string;
  detail?: string;
  category: "sync" | "memory" | "action" | "link";
}

/** Settings & Privacy Models */
export interface ModelSettings {
  chat_model_path: string;
  embedding_model_path: string;
  context_window: number;
}

export interface PrivacyStatus {
  network_access: "OFF";
  cloud_apis: "NONE";
  telemetry: "NONE";
  remote_processing: "NONE";
  local_processing: "ENABLED";
}

