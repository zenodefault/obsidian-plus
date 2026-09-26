import { describe, expect, it, vi } from "vitest";
import {
  applyInstructions,
  approveOperation,
  createOperation,
  executeOperation,
  listActivity,
  listTools,
  planAgent,
  rollbackOperation,
} from "../src/vault/agent";
import type { AgentOperation } from "../src/vault/types";

const sampleOp: AgentOperation = {
  id: "op_1",
  reason: "add link",
  risk_level: "low",
  approval_status: "pending",
  status: "pending",
  created_at: 1,
  files: [
    {
      path: "A.md",
      action: "edit",
      old_hash: "aaa",
      new_hash: "bbb",
      content: "new body",
      old_content: "old body",
    },
  ],
};

describe("agent wrapper", () => {
  it("plans through agent.plan", async () => {
    const request = vi.fn().mockResolvedValue({
      plan: { goal: "g", files: [], rationale: ["why"] },
    });
    const plan = await planAgent({ request }, { request: "link notes", link_target: "Alpha.md" });
    expect(request).toHaveBeenCalledWith("agent.plan", {
      request: "link notes",
      link_target: "Alpha.md",
    });
    expect(plan.rationale).toEqual(["why"]);
  });

  it("creates operations with files payload", async () => {
    const request = vi.fn().mockResolvedValue({ operation: sampleOp });
    const op = await createOperation({ request }, "do it", [
      { path: "A.md", action: "edit", content: "new", old_content: "old" },
    ]);
    expect(request).toHaveBeenCalledWith("agent.create", {
      request: "do it",
      files: [{ path: "A.md", action: "edit", content: "new", old_content: "old" }],
    });
    expect(op.id).toBe("op_1");
  });

  it("attests current hashes before execute", async () => {
    const request = vi.fn().mockResolvedValue({
      operation: { ...sampleOp, approval_status: "approved", status: "executed" },
      apply: [{ path: "A.md", action: "edit", content: "new body" }],
    });
    const { operation, apply } = await executeOperation(
      { request },
      "op_1",
      ["A.md", "Missing.md"],
      async (p) => (p === "A.md" ? "old body" : null),
      (c) => `h(${c})`,
    );
    expect(request).toHaveBeenCalledWith("agent.execute", {
      id: "op_1",
      current: [{ path: "A.md", hash: "h(old body)" }],
    });
    expect(operation.status).toBe("executed");
    expect(apply[0]!.content).toBe("new body");
  });

  it("approve/reject send the operation id", async () => {
    const request = vi.fn().mockResolvedValue({ operation: sampleOp });
    await approveOperation({ request }, "op_1");
    expect(request).toHaveBeenLastCalledWith("agent.approve", { id: "op_1" });
    await rollbackOperation({ request }, "op_1", [], async () => null, (c) => c);
    expect(request).toHaveBeenLastCalledWith("agent.rollback", { id: "op_1", current: [] });
  });

  it("maps apply instructions to vault mutations including delete", () => {
    const mapped = applyInstructions([
      { path: "A.md", action: "edit", content: "body" },
      { path: "Created.md", action: "delete" },
      { path: "Old.md", action: "move", new_path: "New.md" },
    ]);
    expect(mapped).toEqual([
      { path: "A.md", content: "body" },
      { path: "Created.md", delete: true },
      { path: "New.md", content: "" },
    ]);
  });

  it("reads the tool registry and audit trail", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        tools: [{ name: "vault.delete", permission: "vault.delete", decision: "denied", mutates: true }],
      })
      .mockResolvedValueOnce({ events: [], chain_valid: true });
    const tools = await listTools({ request });
    expect(tools[0]!.decision).toBe("denied");
    const activity = await listActivity({ request }, 20);
    expect(request).toHaveBeenLastCalledWith("activity.list", { limit: 20 });
    expect(activity.chain_valid).toBe(true);
  });
});
