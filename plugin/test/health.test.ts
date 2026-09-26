import { describe, expect, it, vi } from "vitest";
import { healthSummary } from "../src/vault/health";

describe("healthSummary", () => {
  it("returns the typed summary from health.summary", async () => {
    const request = vi.fn().mockResolvedValue({
      total_notes: 3,
      total_chunks: 9,
      total_entities: 4,
      total_claims: 5,
      broken_links: [{ kind: "broken_link", path: "A.md", detail: "Missing Note" }],
      orphan_notes: [],
      duplicate_candidates: [
        { note_a: "B.md", note_b: "B-copy.md", similarity: 1.0, reason: "identical content" },
      ],
      failed_jobs: 0,
      pending_jobs: 2,
    });

    const summary = await healthSummary({ request });
    expect(request).toHaveBeenCalledWith("health.summary", {});
    expect(summary.total_notes).toBe(3);
    expect(summary.broken_links[0]!.detail).toBe("Missing Note");
    expect(summary.duplicate_candidates[0]!.similarity).toBe(1.0);
  });

  it("propagates transport errors", async () => {
    const request = vi.fn().mockRejectedValue(new Error("core not running"));
    await expect(healthSummary({ request })).rejects.toThrow("core not running");
  });
});
