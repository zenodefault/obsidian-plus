import { describe, expect, it } from "vitest";
import { RealBrainDataService, type BrainClient } from "../src/services/brainDataService";
import {
  OperationService,
  type VaultBridge,
} from "../src/services/operationService";

/** Scriptable fake client: responses by method, with a running status. */
function fakeClient(
  responses: Record<string, unknown>,
  status: "running" | "stopped" = "running",
): BrainClient & { calls: Array<{ method: string; params: unknown }> } {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    getStatus: () => status,
    request: async <T,>(method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method in responses) return responses[method] as T;
      throw new Error(`unexpected method: ${method}`);
    },
  };
}

describe("RealBrainDataService (wiring)", () => {
  it("maps brain.ask results into the Ask view model", async () => {
    const client = fakeClient({
      "brain.ask": {
        answer: "You chose Postgres [Projects/Decision.md]",
        query_type: "decision",
        confidence: 0.83,
        answer_mode: "evidence",
        sources: [
          {
            note_id: "n1",
            note_path: "Projects/Decision.md",
            chunk_id: "c1",
            heading_path: "Decision",
            snippet: "«We decided» to use Postgres",
            score: 0.71,
          },
        ],
        memories: [],
        contradictions: [],
      },
    });
    const brain = new RealBrainDataService(() => client);
    const result = await brain.queryBrain("what did I decide");

    expect(client.calls[0]!.method).toBe("brain.ask");
    expect(result.confidence).toBe("high");
    expect(result.sources[0]!.title).toBe("Decision.md");
    expect(result.sources[0]!.excerpt).not.toContain("«");
  });

  it("surfaces contradictions as conflicts with both sources", async () => {
    const client = fakeClient({
      "brain.ask": {
        answer: "x",
        query_type: "contradiction",
        confidence: 0.5,
        answer_mode: "evidence",
        sources: [],
        memories: [],
        contradictions: [
          {
            id: "c1",
            kind: "preference_conflict",
            status: "open",
            claim_a: { id: "a", subject: "user", predicate: "prefers", object: "vim", claim_type: "PREFERENCE", polarity: 1, note_path: "Old.md" },
            claim_b: { id: "b", subject: "user", predicate: "prefers", object: "no vim", claim_type: "PREFERENCE", polarity: -1, note_path: "New.md" },
            created_at: 1,
          },
        ],
      },
    });
    const brain = new RealBrainDataService(() => client);
    const result = await brain.queryBrain("conflicts?");
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts![0]!.earlier_source).toBe("Old.md");
    expect(result.conflicts![0]!.later_source).toBe("New.md");
  });

  it("returns the honest offline answer when the core is not running", async () => {
    const client = fakeClient({}, "stopped");
    const brain = new RealBrainDataService(() => client);
    const result = await brain.queryBrain("anything");
    expect(result.answer).toContain("core is not running");
    expect(result.sources).toHaveLength(0);
    expect(client.calls).toHaveLength(0);
    expect(brain.isOnline()).toBe(false);
  });

  it("maps health + contradictions + candidate memories into health cards", async () => {
    const client = fakeClient({
      "health.summary": {
        total_notes: 42,
        total_chunks: 100,
        total_entities: 10,
        total_claims: 20,
        broken_links: [{ kind: "broken_link", path: "A.md", detail: "Missing" }],
        orphan_notes: [],
        duplicate_candidates: [{ note_a: "A.md", note_b: "B.md", similarity: 1, reason: "identical content" }],
        failed_jobs: 0,
        pending_jobs: 0,
      },
      "contradiction.list": { contradictions: [] },
      "memory.list": {
        memories: [
          {
            id: "m1",
            type: "goal",
            content: "learn rust",
            status: "candidate",
            confidence: 0.8,
            user_verified: false,
            created_at: 1,
            updated_at: 1,
            sources: [{ note_id: "n", note_path: "Goals.md", claim_id: "c", excerpt: "x" }],
          },
        ],
      },
    });
    const brain = new RealBrainDataService(() => client);
    const { health, offline } = await brain.getHealthDetailed();
    expect(offline).toBe(false);
    expect(health.indexed_notes).toBe(42);
    expect(health.pending_memories).toBe(1);
    expect(health.duplicate_notes).toBe(1);
    expect(health.broken_links).toBe(1);
  });

  it("maps memory.list entries to review cards with source paths", async () => {
    const client = fakeClient({
      "memory.list": {
        memories: [
          {
            id: "m1",
            type: "preference",
            content: "I prefer vim",
            status: "candidate",
            confidence: 0.8,
            user_verified: false,
            created_at: 1,
            updated_at: 1,
            sources: [{ note_id: "n", note_path: "Notes/Editor.md", claim_id: "c", excerpt: "x" }],
          },
        ],
      },
    });
    const brain = new RealBrainDataService(() => client);
    const items = await brain.getMemories();
    expect(items[0]!.status).toBe("pending");
    expect(items[0]!.source_path).toBe("Notes/Editor.md");
    expect(items[0]!.type).toBe("preference");
  });

  it("sends accept transitions through memory.accept", async () => {
    const client = fakeClient({
      "memory.accept": { memory: {} },
    });
    const brain = new RealBrainDataService(() => client);
    await brain.setMemoryStatus("m1", "accepted");
    expect(client.calls[0]).toEqual({ method: "memory.accept", params: { id: "m1" } });
  });
});

describe("OperationService (wiring)", () => {
  const op = {
    id: "op1",
    reason: "add link",
    risk_level: "low",
    approval_status: "pending",
    status: "pending",
    created_at: 1,
    files: [
      {
        path: "Notes/One.md",
        action: "edit",
        old_hash: "aaa",
        new_hash: "bbb",
        content: "new body",
        old_content: "old body",
      },
    ],
  };

  function memoryBridge(files: Map<string, string>): VaultBridge {
    return {
      read: async (p) => files.get(p) ?? null,
      write: async (p, c) => void files.set(p, c),
      remove: async (p) => files.delete(p),
      exists: (p) => files.has(p),
    };
  }

  it("approveAndApply: approve → execute with attested hash → write vault → verify", async () => {
    const files = new Map<string, string>([["Notes/One.md", "old body"]]);
    const client = fakeClient({
      "agent.approve": { operation: op },
      "operation.get": { operation: op },
      "agent.execute": {
        operation: { ...op, status: "executed" },
        apply: [{ path: "Notes/One.md", action: "edit", content: "new body" }],
      },
      "agent.verify": { message: "verified" },
    });
    const service = new OperationService(() => client, memoryBridge(files));

    const { applied, verified } = await service.approveAndApply("op1");
    expect(applied).toBe(1);
    expect(verified).toBe("verified");
    expect(files.get("Notes/One.md")).toBe("new body");

    const methods = client.calls.map((c) => c.method);
    expect(methods).toEqual([
      "agent.approve",
      "operation.get",
      "agent.execute",
      "agent.verify",
    ]);
    // The attested current hash must be the hash of the pre-state content,
    // computed by the same function the core uses (sha256 of the text).
    const execute = client.calls[2]!;
    const attested = (execute.params as { current: Array<{ path: string; hash: string }> }).current[0]!;
    expect(attested.path).toBe("Notes/One.md");
    expect(attested.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(attested.hash).not.toBe("bbb");
  });

  it("rollback restores pre-state content through the bridge", async () => {
    const files = new Map<string, string>([["Notes/One.md", "new body"]]);
    const executed = { ...op, status: "executed" };
    const client = fakeClient({
      "operation.get": { operation: executed },
      "agent.rollback": {
        operation: { ...op, status: "rolled_back" },
        apply: [{ path: "Notes/One.md", action: "edit", content: "old body" }],
      },
    });
    const service = new OperationService(() => client, memoryBridge(files));
    const { reverted } = await service.rollback("op1");
    expect(reverted).toBe(1);
    expect(files.get("Notes/One.md")).toBe("old body");
  });

  it("lists previews with diffs and mapped statuses", async () => {
    const client = fakeClient({
      "operation.list": { operations: [op] },
    });
    const service = new OperationService(() => client, memoryBridge(new Map()));
    const previews = await service.listPreviews();
    expect(previews[0]!.status).toBe("proposed");
    expect(previews[0]!.affected_files).toEqual(["Notes/One.md"]);
    expect(previews[0]!.diffs[0]!.diff_lines.some((l) => l.type === "add")).toBe(true);
    expect(previews[0]!.diffs[0]!.diff_lines.some((l) => l.type === "delete")).toBe(true);
  });
});
