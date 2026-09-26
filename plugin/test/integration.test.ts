/**
 * Integration: spawns the real core binary (built by cargo) through the same
 * spawn/client code paths the plugin uses at runtime.
 *
 * Skipped cleanly when the binary has not been built yet.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SovereignDaemon } from "../src/services/daemon";
import { RpcErrorImpl } from "../src/types/protocol";
import { hashContent } from "../src/vault/inventory";
import { runSync, sendInventoryBatches } from "../src/vault/sync";
import { searchQuery } from "../src/vault/search";
import type { SyncNote } from "../src/vault/types";

function findCoreBinary(): string | null {
  const pluginRoot = path.resolve(__dirname, "..");
  const candidates = [
    path.join(pluginRoot, "..", "core", "target", "debug", "sovereign-core"),
    path.join(pluginRoot, "..", "core", "target", "release", "sovereign-core"),
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      // next
    }
  }
  return null;
}

const binary = findCoreBinary();
const d = binary ? describe : describe.skip;

let dataDir: string;
let daemon: SovereignDaemon;

d("core integration (real binary)", () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sovereign-int-"));
    daemon = new SovereignDaemon({ binaryPath: binary!, dataDir });
    const health = await daemon.start();
    expect(health.status).toBe("ok");
    expect(health.protocol_version).toBe(1);
  }, 15_000);

  afterAll(async () => {
    if (daemon) await daemon.stop();
  });

  it("answers core.health through the full client stack", async () => {
    const health = await daemon.request<{ status: string; pid: number }>("core.health");
    expect(health.status).toBe("ok");
    expect(health.pid).toBeGreaterThan(0);
  });

  it("surfaces METHOD_NOT_FOUND as a typed RpcError", async () => {
    const promise = daemon.request("agent.plan", { query: "test" }); // brain.ask is real since Part 7
    await expect(promise).rejects.toSatisfy((err: unknown) => {
      const e = err as RpcErrorImpl;
      return e instanceof Error && (e as RpcErrorImpl).code === "METHOD_NOT_FOUND";
    });
  });

  it("runs a full vault sync with rename preservation", async () => {
    // --- Initial sync: two notes.
    const vault = new Map<string, string>([
      ["Projects/A.md", "# A\n\nFirst note."],
      ["Areas/B.md", "# B\n\nSecond note."],
    ]);
    const inventory = [...vault.entries()].map(([p, c]): SyncNote => {
      return { path: p, hash: hashContent(c), mtime: 1, size: c.length };
    });

    const begun = await daemon.request<{ session_id: string }>("vault.sync.begin", {
      rebuild: false,
    });
    await sendInventoryBatches(
      (sid, notes) =>
        daemon.request<{ received: number }>("vault.sync.batch", {
          session_id: sid,
          notes,
        }),
      begun.session_id,
      inventory,
    );
    const diff1 = await daemon.request<{ to_fetch: string[] }>("vault.sync.commit", {
      session_id: begun.session_id,
    });
    expect(diff1.to_fetch.sort()).toEqual(["Areas/B.md", "Projects/A.md"]);
    for (const p of diff1.to_fetch) {
      const content = vault.get(p)!;
      await daemon.request("vault.sync.note", {
        session_id: begun.session_id,
        path: p,
        hash: hashContent(content),
        mtime: 1,
        size: content.length,
        content,
      });
    }
    const fin1 = await daemon.request<{ total_notes: number }>("vault.sync.finish", {
      session_id: begun.session_id,
    });
    expect(fin1.total_notes).toBe(2);

    const state1 = await daemon.request<{ notes: { path: string; note_id: string }[] }>(
      "vault.state.get",
      {},
    );
    const idOf = (p: string) => state1.notes.find((n) => n.path === p)?.note_id;
    const idA = idOf("Projects/A.md");
    expect(idA).toBeTruthy();

    // --- Second sync: A.md renamed to Archive/A-old.md (same content).
    const vault2 = new Map<string, string>([["Archive/A-old.md", vault.get("Projects/A.md")!]]);
    const inv2 = [...vault2.entries()].map(([p, c]): SyncNote => {
      return { path: p, hash: hashContent(c), mtime: 2, size: c.length };
    });
    const begun2 = await daemon.request<{ session_id: string }>("vault.sync.begin", {
      rebuild: false,
    });
    await sendInventoryBatches(
      (sid, notes) =>
        daemon.request<{ received: number }>("vault.sync.batch", {
          session_id: sid,
          notes,
        }),
      begun2.session_id,
      inv2,
    );
    const diff2 = await daemon.request<{
      renamed: { from: string; to: string }[];
      to_fetch: string[];
    }>("vault.sync.commit", { session_id: begun2.session_id });
    expect(diff2.renamed).toEqual([{ from: "Projects/A.md", to: "Archive/A-old.md" }]);
    expect(diff2.to_fetch).toEqual([]); // renames need no re-upload

    const fin2 = await daemon.request<{ total_notes: number }>("vault.sync.finish", {
      session_id: begun2.session_id,
    });
    expect(fin2.total_notes).toBe(1);

    const state2 = await daemon.request<{ notes: { path: string; note_id: string }[] }>(
      "vault.state.get",
      {},
    );
    expect(state2.notes[0]!.note_id).toBe(idA); // identity survived the rename
  });

  it("rejects a note whose content hash does not match", async () => {
    const begun = await daemon.request<{ session_id: string }>("vault.sync.begin", {});
    await daemon.request("vault.sync.batch", {
      session_id: begun.session_id,
      notes: [{ path: "X.md", hash: hashContent("real"), mtime: 1, size: 4 }],
    });
    await daemon.request("vault.sync.commit", { session_id: begun.session_id });
    await expect(
      daemon.request("vault.sync.note", {
        session_id: begun.session_id,
        path: "X.md",
        hash: hashContent("real"),
        mtime: 1,
        size: 9,
        content: "tampered!",
      }),
    ).rejects.toSatisfy((err: unknown) => {
      const e = err as RpcErrorImpl;
      return e instanceof Error && e.message.includes("hash mismatch");
    });
    // Abandon the session so finish's completeness rule isn't violated later.
    await daemon.request("vault.rebuild", {});
  });

  it("runs runSync end-to-end against the orchestrator", async () => {
    const inventory: SyncNote[] = [
      { path: "Orch/One.md", hash: hashContent("one"), mtime: 3, size: 3 },
      { path: "Orch/Two.md", hash: hashContent("two"), mtime: 3, size: 3 },
    ];
    const outcome = await runSync(
      {
        begin: (rebuild) => daemon.request("vault.sync.begin", { rebuild }),
        batch: (sid, notes) =>
          daemon.request("vault.sync.batch", { session_id: sid, notes }),
        commit: (sid) => daemon.request("vault.sync.commit", { session_id: sid }),
        readNote: async (p) => {
          const content = `content of ${p}`;
          return { path: p, hash: hashContent(content), mtime: 3, size: content.length, content };
        },
        uploadNote: (sid, note) =>
          daemon.request("vault.sync.note", { session_id: sid, ...note }),
        finish: (sid) => daemon.request("vault.sync.finish", { session_id: sid }),
      },
      inventory,
    );
    expect(outcome.persisted).toBe(true);
    expect(outcome.totalNotes).toBe(2);
    expect(outcome.uploaded).toBe(2);
  });

  it("searches synced content through the FTS index", async () => {
    const content = "# Quantum Notes\n\nEntanglement links distant particles.\n";
    const begun = await daemon.request<{ session_id: string }>("vault.sync.begin", {});
    await daemon.request("vault.sync.batch", {
      session_id: begun.session_id,
      notes: [
        { path: "Sci/Quantum.md", hash: hashContent(content), mtime: 9, size: content.length },
        { path: "Sci/Other.md", hash: hashContent("nothing relevant"), mtime: 9, size: 16 },
      ],
    });
    const diff = await daemon.request<{ to_fetch: string[] }>("vault.sync.commit", {
      session_id: begun.session_id,
    });
    for (const p of diff.to_fetch) {
      const c = p === "Sci/Quantum.md" ? content : "nothing relevant";
      await daemon.request("vault.sync.note", {
        session_id: begun.session_id,
        path: p,
        hash: hashContent(c),
        mtime: 9,
        size: c.length,
        content: c,
      });
    }
    await daemon.request("vault.sync.finish", { session_id: begun.session_id });

    const result = await daemon.request<{
      hits: { note_path: string; snippet: string }[];
    }>("search.query", { query: "entanglement particles", limit: 5 });
    expect(result.hits.length).toBeGreaterThanOrEqual(1);
    expect(result.hits[0]!.note_path).toBe("Sci/Quantum.md");
    expect(result.hits[0]!.snippet.length).toBeGreaterThan(0);

    // The search wrapper resolves through the same client.
    const hits = await searchQuery(daemon, "entanglement", 3);
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  it("restarts cleanly on demand", async () => {
    const health = await daemon.restart();
    expect(health.status).toBe("ok");
    const again = await daemon.request<{ status: string }>("core.health");
    expect(again.status).toBe("ok");
  });

  it("shuts down gracefully", async () => {
    await daemon.stop();
    expect(daemon.getStatus()).toBe("stopped");
  });
});
