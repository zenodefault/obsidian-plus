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
    const promise = daemon.request("brain.ask", { query: "test" });
    await expect(promise).rejects.toSatisfy((err: unknown) => {
      const e = err as RpcErrorImpl;
      return e instanceof Error && (e as RpcErrorImpl).code === "METHOD_NOT_FOUND";
    });
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
