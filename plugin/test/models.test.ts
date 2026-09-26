import { describe, expect, it, vi } from "vitest";
import { modelsStatus, searchQuery } from "../src/vault/search";

describe("modelsStatus", () => {
  it("returns typed model status", async () => {
    const request = vi.fn().mockResolvedValue({
      provider: "cli",
      model_path: "/models/embed.gguf",
      binary_path: "/usr/local/bin/llama-embedding",
      dimension: 768,
      chunks_total: 180,
      chunks_embedded: 175,
      chunks_pending: 5,
      validation_error: null,
    });
    const status = await modelsStatus({ request });
    expect(request).toHaveBeenCalledWith("models.status", {});
    expect(status.provider).toBe("cli");
    expect(status.chunks_pending).toBe(5);
    expect(status.validation_error).toBeNull();
  });
});

describe("searchQuery (hybrid hits)", () => {
  it("passes hits with breakdowns through untouched", async () => {
    const request = vi.fn().mockResolvedValue({
      hits: [
        {
          note_id: "n1",
          note_path: "A.md",
          chunk_id: "c1",
          heading_path: "Setup",
          snippet: "…match…",
          score: 0.82,
          score_breakdown: { lexical: 0.9, semantic: 0.7, entity: 0.5 },
        },
      ],
      total_notes: 1,
    });
    const hits = await searchQuery({ request }, "match");
    expect(hits[0]!.score_breakdown).toEqual({
      lexical: 0.9,
      semantic: 0.7,
      entity: 0.5,
    });
  });

  it("handles lexical-only fallback hits without breakdown", async () => {
    const request = vi.fn().mockResolvedValue({
      hits: [
        {
          note_id: "n1",
          note_path: "A.md",
          chunk_id: "c1",
          heading_path: "",
          snippet: "…",
          score: 0.4,
        },
      ],
      total_notes: 1,
    });
    const hits = await searchQuery({ request }, "match");
    expect(hits[0]!.score_breakdown).toBeUndefined();
  });
});
