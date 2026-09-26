/**
 * Memory service (§14, §18–20): typed access to the memory review lifecycle
 * and contradiction resolution. All mutations are user-driven review
 * decisions (§50) — nothing here is automatic.
 */

import type { ContradictionEntry, ContradictionResolution, MemoryEntry } from "./types";

export interface MemoryClient {
  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}

/** List memories, optionally filtered by status. */
export async function listMemories(
  client: MemoryClient,
  status?: string,
): Promise<MemoryEntry[]> {
  const result = await client.request<{ memories: MemoryEntry[] }>("memory.list", {
    status: status ?? null,
  });
  return result.memories;
}

/** Accept a candidate memory (§50: User Review → Accepted). */
export async function acceptMemory(client: MemoryClient, id: string): Promise<MemoryEntry> {
  const result = await client.request<{ memory: MemoryEntry }>("memory.accept", { id });
  return result.memory;
}

/** Reject a candidate memory. */
export async function rejectMemory(client: MemoryClient, id: string): Promise<MemoryEntry> {
  const result = await client.request<{ memory: MemoryEntry }>("memory.reject", { id });
  return result.memory;
}

/** Edit a memory's content and/or type. */
export async function updateMemory(
  client: MemoryClient,
  id: string,
  patch: { content?: string; type?: string },
): Promise<MemoryEntry> {
  const result = await client.request<{ memory: MemoryEntry }>("memory.update", {
    id,
    content: patch.content ?? null,
    type: patch.type ?? null,
  });
  return result.memory;
}

/** Supersede: record a changed statement; the old memory becomes superseded. */
export async function supersedeMemory(
  client: MemoryClient,
  id: string,
  content: string,
  type?: string,
): Promise<MemoryEntry> {
  const result = await client.request<{ memory: MemoryEntry }>("memory.supersede", {
    id,
    content,
    type: type ?? null,
  });
  return result.memory;
}

/** List open contradictions (both sources attached, §54). */
export async function listContradictions(client: MemoryClient): Promise<ContradictionEntry[]> {
  const result = await client.request<{ contradictions: ContradictionEntry[] }>(
    "contradiction.list",
    {},
  );
  return result.contradictions;
}

/** Resolve a contradiction (§20: Keep Both / Mark Later as Current / Ignore). */
export async function resolveContradiction(
  client: MemoryClient,
  id: string,
  resolution: ContradictionResolution,
): Promise<string> {
  const result = await client.request<{ message: string }>("contradiction.resolve", {
    id,
    resolution,
  });
  return result.message;
}
