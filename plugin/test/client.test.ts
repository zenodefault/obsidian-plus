import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { CoreClient, DEFAULT_REQUEST_TIMEOUT_MS } from "../src/services/daemon/client";
import { RpcErrorImpl } from "../src/types/protocol";

function makeFakeChild() {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stdout.setEncoding = () => undefined;
  const stdin = new PassThrough();
  const written: string[] = [];
  stdin.on("data", (chunk: Buffer) => written.push(chunk.toString("utf8")));
  const child = { stdout, stdin } as unknown as ChildProcess;
  return { child, stdout, stdin, written };
}

function lines(written: string[]): string[] {
  return written.join("").split("\n").filter((l) => l.length > 0);
}

describe("CoreClient", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("correlates a response to its pending request", async () => {
    const { child, stdout, written } = makeFakeChild();
    const client = new CoreClient(child);
    const pending = client.request<{ status: string }>("core.health");

    expect(lines(written)).toEqual(['{"id":"req_1","method":"core.health","params":{}}']);
    stdout.emit("data", '{"id":"req_1","result":{"status":"ok","pid":1}}\n');

    await expect(pending).resolves.toMatchObject({ status: "ok" });
    client.close();
  });

  it("handles responses split across chunks", async () => {
    const { child, stdout } = makeFakeChild();
    const client = new CoreClient(child);
    const pending = client.request("core.health");

    stdout.emit("data", '{"id":"req_1","res');
    stdout.emit("data", 'ult":{"status":"ok"}}\n');
    await expect(pending).resolves.toMatchObject({ status: "ok" });
    client.close();
  });

  it("rejects with a typed error from the core", async () => {
    const { child, stdout } = makeFakeChild();
    const client = new CoreClient(child);
    const pending = client.request("brain.ask");

    stdout.emit(
      "data",
      '{"id":"req_1","error":{"code":"METHOD_NOT_FOUND","message":"unknown method: brain.ask","request_id":"req_1"}}\n',
    );

    await expect(pending).rejects.toMatchObject({
      code: "METHOD_NOT_FOUND",
      message: "unknown method: brain.ask",
    });
    client.close();
  });

  it("times out a request with a typed error", async () => {
    vi.useFakeTimers();
    const { child } = makeFakeChild();
    const client = new CoreClient(child);
    const pending = client.request("core.health", {}, 500);
    const assertion = expect(pending).rejects.toSatisfy((err: unknown) => {
      const e = err as RpcErrorImpl;
      return e instanceof Error && e.message.includes("timed out");
    });
    await vi.advanceTimersByTimeAsync(501);
    await assertion;
    client.close();
  });

  it("uses the default timeout when none is given", async () => {
    vi.useFakeTimers();
    const { child } = makeFakeChild();
    const client = new CoreClient(child);
    const pending = client.request("core.health");
    const assertion = expect(pending).rejects.toSatisfy((err: unknown) => {
      const e = err as RpcErrorImpl;
      return e instanceof Error && e.message.includes(`${DEFAULT_REQUEST_TIMEOUT_MS}`);
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS + 1);
    await assertion;
    client.close();
  });

  it("fails pending requests when the core exits", async () => {
    const { child } = makeFakeChild();
    const client = new CoreClient(child);
    const pending = client.request("core.health");
    const assertion = expect(pending).rejects.toMatchObject({ message: "core exited" });

    // The daemon wires proc.exit → failPending; the client contract is that
    // failPending rejects everything pending with the given reason.
    client.failPending("core exited");
    await assertion;
    client.close();
  });

  it("reports responses for unknown ids via onProtocolError", async () => {
    const { child, stdout } = makeFakeChild();
    const onProtocolError = vi.fn();
    const client = new CoreClient(child, { onProtocolError });

    stdout.emit("data", '{"id":"req_999","result":{}}\n');
    expect(onProtocolError).toHaveBeenCalledTimes(1);
    client.close();
  });

  it("reports unparseable core output via onProtocolError", async () => {
    const { child, stdout } = makeFakeChild();
    const onProtocolError = vi.fn();
    const client = new CoreClient(child, { onProtocolError });

    stdout.emit("data", "{{{not json\n");
    expect(onProtocolError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PARSE_ERROR" }),
    );
    client.close();
  });

  it("rejects requests made after close", async () => {
    const { child } = makeFakeChild();
    const client = new CoreClient(child);
    client.close();
    await expect(client.request("core.health")).rejects.toMatchObject({
      message: "client is closed",
    });
  });

  it("does not send oversized lines and fails fast", async () => {
    const { child, written } = makeFakeChild();
    const client = new CoreClient(child);
    const big = "x".repeat(10 * 1024 * 1024 + 1);
    const pending = client.request("vault.sync", { blob: big });
    await expect(pending).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(lines(written)).toEqual([]);
    client.close();
  });
});
