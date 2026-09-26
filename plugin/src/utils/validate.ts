/**
 * Strict runtime validation of protocol envelopes.
 *
 * TypeScript types are compile-time only; messages arrive from an external
 * process and must be validated at runtime before use. Mirrors the Rust
 * `deny_unknown_fields` semantics.
 */

import { Envelope, RpcError } from "../types/protocol";

const ERROR_CODES = new Set([
  "PARSE_ERROR",
  "INVALID_REQUEST",
  "METHOD_NOT_FOUND",
  "INVALID_PARAMS",
  "INTERNAL",
  "FILE_VERSION_CONFLICT",
  "PERMISSION_DENIED",
]);

const ENVELOPE_KEYS = new Set(["id", "method", "params", "result", "error"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a wire line into an Envelope, or return null when structurally
 * invalid. Rejects wrong types and unknown fields.
 */
export function parseEnvelope(raw: string): Envelope | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  for (const key of Object.keys(value)) {
    if (!ENVELOPE_KEYS.has(key)) return null;
  }

  const { id, method, params, result, error } = value;
  if (id !== undefined && typeof id !== "string") return null;
  if (method !== undefined && typeof method !== "string") return null;
  if (params !== undefined && !isRecord(params) && params !== null) return null;
  if (error !== undefined && !isValidError(error)) return null;
  if (result !== undefined && error !== undefined) return null;

  const env: Envelope = {};
  if (id !== undefined) env.id = id as string;
  if (method !== undefined) env.method = method as string;
  if (params !== undefined) env.params = params;
  if (result !== undefined) env.result = result;
  if (error !== undefined) env.error = error as RpcError;
  return env;
}

function isValidError(value: unknown): value is RpcError {
  if (!isRecord(value)) return false;
  const { code, message, details, request_id } = value;
  if (typeof code !== "string" || !ERROR_CODES.has(code)) return false;
  if (typeof message !== "string") return false;
  if (details !== undefined && !isRecord(details) && details !== null) return false;
  if (request_id !== undefined && typeof request_id !== "string") return false;
  for (const key of Object.keys(value)) {
    if (!["code", "message", "details", "request_id"].includes(key)) return false;
  }
  return true;
}
