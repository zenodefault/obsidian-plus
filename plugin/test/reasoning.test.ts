import { describe, expect, it, vi } from "vitest";
import { ask } from "../src/vault/reasoning";
import type { AskResult } from "../src/vault/types";

const sample: AskResult = {
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
      snippet: "We decided to use Postgres.",
      score: 0.7,
    },
  ],
  memories: [],
  contradictions: [],
};

describe("reasoning wrapper", () => {
  it("sends brain.ask with trimmed query and bounded limit", async () => {
    const request = vi.fn().mockResolvedValue(sample);
    const result = await ask({ request }, "  what did I decide?  ", 4);
    expect(request).toHaveBeenCalledWith("brain.ask", { query: "what did I decide?", limit: 4 });
    expect(result.answer).toContain("Postgres");
    expect(result.sources[0]!.note_path).toBe("Projects/Decision.md");
  });

  it("clamps limit into 1..=20 and defaults to 6", async () => {
    const request = vi.fn().mockResolvedValue(sample);
    await ask({ request }, "q", 999);
    expect(request).toHaveBeenLastCalledWith("brain.ask", { query: "q", limit: 20 });
    await ask({ request }, "q", 0);
    expect(request).toHaveBeenLastCalledWith("brain.ask", { query: "q", limit: 1 });
    await ask({ request }, "q");
    expect(request).toHaveBeenLastCalledWith("brain.ask", { query: "q", limit: 6 });
  });

  it("refuses empty queries locally", async () => {
    const request = vi.fn();
    await expect(ask({ request }, "   ")).rejects.toThrow("empty");
    expect(request).not.toHaveBeenCalled();
  });

  it("carries answer_mode so the UI can label degraded answers", async () => {
    const request = vi.fn().mockResolvedValue({
      ...sample,
      answer: "I couldn't find evidence for this in the vault.",
      answer_mode: "no_evidence",
      confidence: 0,
      sources: [],
    });
    const result = await ask({ request }, "obscure topic");
    expect(result.answer_mode).toBe("no_evidence");
    expect(result.confidence).toBe(0);
  });
});
