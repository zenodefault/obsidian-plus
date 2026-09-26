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
