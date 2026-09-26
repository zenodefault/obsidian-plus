import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { Debouncer, hashContent, normalizePath } from "../src/vault/inventory";
import {
  runSync,
  sendInventoryBatches,
  SyncAbortedError,
  BATCH_SIZE,
} from "../src/vault/sync";
import type { SyncNote } from "../src/vault/types";

describe("hashContent", () => {
  it("matches node sha256 and core's canonical hashing", () => {
    const expected = createHash("sha256").update("hello", "utf8").digest("hex");
    expect(hashContent("hello")).toBe(expected);
    expect(hashContent("hello")).toHaveLength(64);
    // Same definition as core/src/vault/manager.rs hash_content.
    expect(hashContent("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("normalizePath", () => {
  it("uses forward slashes and strips leading separators", () => {
    expect(normalizePath("a\\b\\c.md")).toBe("a/b/c.md");
    expect(normalizePath("/top.md")).toBe("top.md");
    expect(normalizePath("already/fine.md")).toBe("already/fine.md");
  });
});

describe("Debouncer", () => {
  it("collapses bursts into one trailing call", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = new Debouncer(100);
    d.run(fn);
    vi.advanceTimersByTime(50);
    d.run(fn);
    vi.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(51);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("cancel drops the pending call", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = new Debouncer(50);
    d.run(fn);
    d.cancel();
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
    expect(d.pending).toBe(false);
    vi.useRealTimers();
  });

  it("reports whether a call was replaced", () => {
    vi.useFakeTimers();
    const d = new Debouncer(50);
    expect(d.run(() => undefined)).toBe(false);
    expect(d.run(() => undefined)).toBe(true);
    vi.useRealTimers();
  });
});

function makeDeps(notes: Map<string, string>, uploaded: string[]) {
  const hashOf = (c: string) => hashContent(c);
  const inv = [...notes.entries()].map(([path, content]): SyncNote => {
    return { path, hash: hashOf(content), mtime: 1, size: content.length };
  });
  return {
    inv,
    deps: {
      begin: vi.fn().mockResolvedValue({ session_id: "s-1", rebuild: false }),
      batch: vi.fn().mockResolvedValue({ received: 1 }),
      commit: vi.fn().mockResolvedValue({
        added: inv.map((n) => n.path),
        modified: [],
        renamed: [],
        deleted: [],
        to_fetch: inv.map((n) => n.path),
        applied: 0,
      }),
      readNote: vi.fn(async (path: string) => {
        const content = notes.get(path);
        if (content === undefined) throw new Error(`missing ${path}`);
        uploaded.push(path);
        return { path, hash: hashOf(content), mtime: 1, size: content.length, content };
      }),
      uploadNote: vi.fn(async (_sid: string, note: SyncNote) => ({
        path: note.path,
        note_id: `id-${note.path}`,
        updated: false,
      })),
      finish: vi.fn().mockResolvedValue({ total_notes: notes.size, persisted: true }),
    },
  };
}

describe("runSync", () => {
  it("uploads only the notes the core requested", async () => {
    const uploaded: string[] = [];
    const { deps, inv } = makeDeps(new Map([["A.md", "alpha"], ["B.md", "beta"]]), uploaded);
    const outcome = await runSync(deps, inv);
    expect(uploaded.sort()).toEqual(["A.md", "B.md"]);
    expect(outcome.totalNotes).toBe(2);
    expect(outcome.persisted).toBe(true);
    expect(outcome.uploaded).toBe(2);
    expect(deps.begin).toHaveBeenCalledWith(false);
    expect(deps.finish).toHaveBeenCalledWith("s-1");
  });

  it("batches large inventories", async () => {
    const uploaded: string[] = [];
    const notes = new Map<string, string>();
    for (let i = 0; i < 450; i++) notes.set(`n${i}.md`, `content ${i}`);
    const { deps, inv } = makeDeps(notes, uploaded);
    await runSync(deps, inv);
    expect(deps.batch).toHaveBeenCalledTimes(3); // 200 + 200 + 50
  });

  it("reports progress through each stage", async () => {
    const uploaded: string[] = [];
    const { deps, inv } = makeDeps(new Map([["A.md", "x"]]), uploaded);
    const progress = vi.fn();
    await runSync(deps, inv, { onProgress: progress });
    expect(progress).toHaveBeenCalledWith("inventory", 1, 1);
    expect(progress).toHaveBeenCalledWith("committed", 1, 1);
    expect(progress).toHaveBeenCalledWith("uploading", 1, 1);
  });

  it("aborts cleanly between steps", async () => {
    const uploaded: string[] = [];
    const { deps, inv } = makeDeps(new Map([["A.md", "x"], ["B.md", "y"]]), uploaded);
    let calls = 0;
    await expect(
      runSync(deps, inv, {
        shouldAbort: () => ++calls > 2,
      }),
    ).rejects.toBeInstanceOf(SyncAbortedError);
    expect(deps.finish).not.toHaveBeenCalled();
  });

  it("handles an empty vault", async () => {
    const uploaded: string[] = [];
    const { deps, inv } = makeDeps(new Map(), uploaded);
    const outcome = await runSync(deps, inv);
    expect(outcome.totalNotes).toBe(0);
    expect(outcome.uploaded).toBe(0);
  });
});

describe("sendInventoryBatches", () => {
  it("chunks inventory at BATCH_SIZE", async () => {
    const batch = vi.fn(
      (_sid: string, chunk: SyncNote[]) => Promise.resolve({ received: chunk.length }),
    );
    const notes: SyncNote[] = Array.from({ length: 450 }, (_, i) => ({
      path: `n${i}.md`,
      hash: "h".repeat(64),
      mtime: 0,
      size: 0,
    }));
    const received = await sendInventoryBatches(batch, "s", notes);
    expect(batch).toHaveBeenCalledTimes(3); // 200 + 200 + 50
    expect(received).toBe(450);
  });

  it("sends nothing for an empty vault", async () => {
    const batch = vi.fn();
    const received = await sendInventoryBatches(batch, "s", []);
    expect(batch).not.toHaveBeenCalled();
    expect(received).toBe(0);
    void BATCH_SIZE;
  });
});
