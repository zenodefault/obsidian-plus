/**
 * Reasoning service (§56–58, §107): typed access to `brain.ask`. The core
 * classifies the query, assembles evidence deterministically and — only when
 * a local generate-capable model is configured — drafts an answer whose
 * citations are validated before delivery (§58: never fabricate).
 */

import type { AskResult } from "./types";

/** Default context size shared with the core (§56). */
export const DEFAULT_ASK_LIMIT = 6;

/**
 * Local-model generation is slower than any network round trip: a 4B chat
 * model reasons for tens of seconds on first load (and Ollama may be loading
 * the model into RAM at all). The 15s default RPC timeout would abandon the
 * request mid-answer ("Unable to answer right now" while Ollama keeps
 * generating), so ask waits — and the core itself bounds the model call.
 */
export const ASK_REQUEST_TIMEOUT_MS = 300_000;

export interface ReasoningClient {
  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}

/** Ask the brain a question and receive an evidence-backed answer. */
export async function ask(
  client: ReasoningClient,
  query: string,
  limit = DEFAULT_ASK_LIMIT,
): Promise<AskResult> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    throw new Error("query must not be empty");
  }
  return client.request<AskResult>("brain.ask", {
    query: trimmed,
    limit: Math.min(Math.max(1, limit), 20),
  }, ASK_REQUEST_TIMEOUT_MS);
}
