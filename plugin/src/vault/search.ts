/**
 * Search service: typed wrapper over `search.query` (Part 3 fast path).
 * UI surfaces consume this — never raw protocol envelopes (§33, §34).
 */

import type { ModelStatus, SearchHit, SearchQueryResult } from "./types";

/** Hard cap shared with the core's dispatch (§94: bounded responses). */
export const MAX_SEARCH_LIMIT = 100;

export interface SearchClient {
  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}

/** Run a hybrid search. Empty/whitespace queries return no hits. */
export async function searchQuery(
  client: SearchClient,
  query: string,
  limit = 20,
): Promise<SearchHit[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  const capped = Math.min(Math.max(1, limit), MAX_SEARCH_LIMIT);
  const result = await client.request<SearchQueryResult>("search.query", {
    query: trimmed,
    limit: capped,
  });
  return result.hits;
}

/** Fetch local model status (§74): provider, coverage, validation errors. */
export async function modelsStatus(client: SearchClient): Promise<ModelStatus> {
  return client.request<ModelStatus>("models.status", {});
}
