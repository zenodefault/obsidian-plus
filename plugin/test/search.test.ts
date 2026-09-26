import { describe, expect, it, vi } from "vitest";
import { MAX_SEARCH_LIMIT, searchQuery } from "../src/vault/search";

describe("searchQuery", () => {
  it("returns no hits for blank queries without a round-trip", async () => {
    const request = vi.fn();
    expect(await searchQuery({ request }, "   ")).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it("sends trimmed query with capped limit", async () => {
    const request = vi.fn().mockResolvedValue({ hits: [{ note_path: "A.md" }], total_notes: 1 });
    const hits = await searchQuery({ request }, "  rust  ", 5000);
    expect(request).toHaveBeenCalledWith("search.query", { query: "rust", limit: MAX_SEARCH_LIMIT });
    expect(hits).toHaveLength(1);
  });

  it("propagates typed RpcErrors from the client", async () => {
    const request = vi.fn().mockRejectedValue(new Error("METHOD_NOT_FOUND"));
    await expect(searchQuery({ request }, "x")).rejects.toThrow("METHOD_NOT_FOUND");
  });
});
