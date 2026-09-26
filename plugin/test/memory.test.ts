import { describe, expect, it, vi } from "vitest";
import {
  acceptMemory,
  listContradictions,
  listMemories,
  rejectMemory,
  resolveContradiction,
  supersedeMemory,
  updateMemory,
} from "../src/vault/memory";

const sample = {
  id: "mem_1",
  type: "goal",
  content: "My goal is learning distributed systems.",
  status: "accepted",
  confidence: 0.8,
  user_verified: true,
  created_at: 1,
  updated_at: 2,
  sources: [{ note_id: "n1", note_path: "Goals.md", claim_id: "c1", excerpt: "My goal…" }],
};

describe("memory wrapper", () => {
  it("lists memories with optional status filter", async () => {
    const request = vi.fn().mockResolvedValue({ memories: [sample] });
    const all = await listMemories({ request });
    expect(request).toHaveBeenCalledWith("memory.list", { status: null });
    expect(all[0]!.sources[0]!.note_path).toBe("Goals.md");

    const pending = await listMemories({ request }, "candidate");
    expect(request).toHaveBeenLastCalledWith("memory.list", { status: "candidate" });
    expect(pending).toEqual([sample]);
  });

  it("accept / reject / update / supersede pass ids and patches", async () => {
    const request = vi.fn().mockResolvedValue({ memory: sample });
    await acceptMemory({ request }, "mem_1");
    expect(request).toHaveBeenLastCalledWith("memory.accept", { id: "mem_1" });

    await rejectMemory({ request }, "mem_1");
    expect(request).toHaveBeenLastCalledWith("memory.reject", { id: "mem_1" });

    await updateMemory({ request }, "mem_1", { content: "New text", type: "preference" });
    expect(request).toHaveBeenLastCalledWith("memory.update", {
      id: "mem_1",
      content: "New text",
      type: "preference",
    });

    await supersedeMemory({ request }, "mem_1", "Newer statement");
    expect(request).toHaveBeenLastCalledWith("memory.supersede", {
      id: "mem_1",
      content: "Newer statement",
      type: null,
    });
  });

  it("lists contradictions and resolves them", async () => {
    const contradictions = [
      {
        id: "con_1",
        kind: "preference_conflict",
        status: "open",
        claim_a: { id: "c1", subject: "user", predicate: "prefers", object: "Vim", claim_type: "PREFERENCE", polarity: 1, note_path: "Old.md" },
        claim_b: { id: "c2", subject: "user", predicate: "prefers", object: "no Vim", claim_type: "PREFERENCE", polarity: -1, note_path: "New.md" },
        created_at: 5,
      },
    ];
    const request = vi
      .fn()
      .mockResolvedValueOnce({ contradictions })
      .mockResolvedValueOnce({ message: "later claim marked current" });

    const list = await listContradictions({ request });
    expect(list[0]!.claim_a.note_path).toBe("Old.md");
    expect(list[0]!.claim_b.polarity).toBe(-1);

    const message = await resolveContradiction({ request }, "con_1", "mark_later_current");
    expect(request).toHaveBeenLastCalledWith("contradiction.resolve", {
      id: "con_1",
      resolution: "mark_later_current",
    });
    expect(message).toContain("marked current");
  });
});
