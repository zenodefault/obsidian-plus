/**
 * Agent service (§59–66): typed access to the approval-gated operation
 * pipeline. The core plans and validates; THIS module is where approved
 * changes actually touch the vault (§4.1: the core never writes to it) and
 * verifies the result (§59). Every mutation flows:
 *
 *   plan/create → preview → user approves → execute (version check) →
 *   apply locally → verify → audit.
 */

import type {
  AgentFileInput,
  AgentOperation,
  AgentPlan,
  AgentTool,
  ApplyFile,
  AuditEvent,
  PathHash,
} from "./types";

export interface AgentClient {
  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}

/** Ask the core for a deterministic proposal (nothing is applied). */
export async function planAgent(client: AgentClient, params: {
  request: string;
  link_target?: string;
  merge_paths?: string[];
  merge_target?: string;
}): Promise<AgentPlan> {
  const result = await client.request<{ plan: AgentPlan }>("agent.plan", params);
  return result.plan;
}

/** Wrap proposed file changes into a previewed operation. */
export async function createOperation(
  client: AgentClient,
  request: string,
  files: AgentFileInput[],
): Promise<AgentOperation> {
  const result = await client.request<{ operation: AgentOperation }>("agent.create", {
    request,
    files,
  });
  return result.operation;
}

/** Approve / reject a previewed operation (§63: explicit user decision). */
export async function approveOperation(client: AgentClient, id: string): Promise<AgentOperation> {
  const result = await client.request<{ operation: AgentOperation }>("agent.approve", { id });
  return result.operation;
}

export async function rejectOperation(client: AgentClient, id: string): Promise<AgentOperation> {
  const result = await client.request<{ operation: AgentOperation }>("agent.reject", { id });
  return result.operation;
}

/**
 * Execute an approved operation. `readHashes` supplies the plugin's attested
 * current path→hash state for the version check (§64). Returns the apply
 * instructions; applying them is the plugin's job via `applyInstructions`.
 */
export async function executeOperation(
  client: AgentClient,
  id: string,
  paths: string[],
  readContent: (path: string) => Promise<string | null>,
  hashContent: (content: string) => string,
): Promise<{ operation: AgentOperation; apply: ApplyFile[] }> {
  const current: PathHash[] = [];
  for (const p of paths) {
    const content = await readContent(p);
    if (content !== null) {
      current.push({ path: p, hash: hashContent(content) });
    }
  }
  const result = await client.request<{ operation: AgentOperation; apply: ApplyFile[] }>(
    "agent.execute",
    { id, current },
  );
  return result;
}

/** Record post-apply hashes so the core can audit verification (§59). */
export async function verifyOperation(
  client: AgentClient,
  id: string,
  applied: PathHash[],
): Promise<string> {
  const result = await client.request<{ message: string }>("agent.verify", { id, applied });
  return result.message;
}

/** Rollback to the pre-operation state (§65; version-checked by the core). */
export async function rollbackOperation(
  client: AgentClient,
  id: string,
  paths: string[],
  readContent: (path: string) => Promise<string | null>,
  hashContent: (content: string) => string,
): Promise<{ operation: AgentOperation; apply: ApplyFile[] }> {
  const current: PathHash[] = [];
  for (const p of paths) {
    const content = await readContent(p);
    if (content !== null) {
      current.push({ path: p, hash: hashContent(content) });
    }
  }
  const result = await client.request<{ operation: AgentOperation; apply: ApplyFile[] }>(
    "agent.rollback",
    { id, current },
  );
  return result;
}

/** Fetch the tool registry with the §61 default matrix. */
export async function listTools(client: AgentClient): Promise<AgentTool[]> {
  const result = await client.request<{ tools: AgentTool[] }>("agent.tools", {});
  return result.tools;
}

export async function listOperations(client: AgentClient, limit?: number): Promise<AgentOperation[]> {
  const result = await client.request<{ operations: AgentOperation[] }>("operation.list", {
    limit: limit ?? null,
  });
  return result.operations;
}

export async function getOperation(client: AgentClient, id: string): Promise<AgentOperation> {
  const result = await client.request<{ operation: AgentOperation }>("operation.get", { id });
  return result.operation;
}

/** The audit trail (§66) with chain verification status. */
export async function listActivity(
  client: AgentClient,
  limit = 100,
): Promise<{ events: AuditEvent[]; chain_valid: boolean }> {
  return client.request<{ events: AuditEvent[]; chain_valid: boolean }>("activity.list", {
    limit,
  });
}

/**
 * Pure helper: turn apply instructions into file mutations the vault bridge
 * can perform. Delete instructions (rollback of a created file) come back as
 * `{ path, action: "delete" }` and must be routed to the vault's delete.
 */
export function applyInstructions(
  apply: ApplyFile[],
): Array<{ path: string; content: string } | { path: string; delete: true }> {
  return apply.map((a) => {
    if (a.action === "delete") {
      return { path: a.path, delete: true as const };
    }
    return { path: a.new_path ?? a.path, content: a.content ?? "" };
  });
}
