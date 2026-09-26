/**
 * Brain health wrapper (§25, §68): typed access to `health.summary`.
 * Detection-only — the core never acts on these findings by itself (§69).
 */

export interface HealthFinding {
  kind: string;
  path: string;
  detail: string;
}

export interface HealthDuplicate {
  note_a: string;
  note_b: string;
  similarity: number;
  reason: string;
}

export interface HealthSummary {
  total_notes: number;
  total_chunks: number;
  total_entities: number;
  total_claims: number;
  broken_links: HealthFinding[];
  orphan_notes: HealthFinding[];
  duplicate_candidates: HealthDuplicate[];
  failed_jobs: number;
  pending_jobs: number;
}

export interface HealthClient {
  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}

/** Fetch the current brain health summary. */
export async function healthSummary(client: HealthClient): Promise<HealthSummary> {
  return client.request<HealthSummary>("health.summary", {});
}
