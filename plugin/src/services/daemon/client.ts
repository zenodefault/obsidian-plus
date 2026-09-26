/**
 * Request/response client for the Sovereign Core over NDJSON stdio.
 *
 * Responsibilities:
 * - newline-delimited JSON framing (read and write)
 * - correlating responses to pending requests by `id`
 * - per-request timeout (`INTERNAL`-style rejection with code `TIMEOUT`)
 * - safe line size cap matching the core (10 MB)
 * - draining pending requests with a typed error on unexpected core exit
 */

import type { ChildProcess } from "node:child_process";
import {
  Envelope,
  RpcError,
  RpcErrorImpl,
} from "../../types/protocol";

/** Maximum accepted line size — must match core/src/ipc.rs MAX_LINE_BYTES. */
export const MAX_LINE_BYTES = 10 * 1024 * 1024;

/** Default per-request timeout. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

interface Pending {
  resolve: (value: Envelope) => void;
  reject: (err: RpcErrorImpl) => void;
  timer: NodeJS.Timeout;
}

export interface ClientOptions {
  /** Called for each protocol error the core reports unprompted. */
  onProtocolError?: (err: RpcError) => void;
}

/**
 * Attaches to a running core child process and exchanges envelopes.
 * One client per core process; call `close()` before stopping the process.
 */
export class CoreClient {
  private pending = new Map<string, Pending>();
  private nextId = 0;
  private buffer = "";
  private closed = false;

  constructor(
    private readonly child: ChildProcess,
    private readonly opts: ClientOptions = {},
  ) {
    if (!child.stdout || !child.stdin) {
      throw new Error("core child process must have piped stdin/stdout");
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleData(chunk));
    // The spawn layer notifies about unexpected exits; here we only fail
    // pending requests so callers get a typed error instead of hanging.
  }

  /** Fail all pending requests (used on unexpected core exit or client close). */
  failPending(reason: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new RpcErrorImpl("INTERNAL", reason, undefined, id));
    }
    this.pending.clear();
  }

  /** Send a request and await its typed response. Rejects with RpcErrorImpl. */
  request<T = unknown>(
    method: string,
    params: unknown = {},
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new RpcErrorImpl("INTERNAL", "client is closed"));
    }
    const id = `req_${++this.nextId}`;
    const envelope: Envelope = { id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcErrorImpl("INTERNAL", `request timed out after ${timeoutMs}ms: ${method}`, undefined, id));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (env) => resolve(env.result as T),
        reject,
        timer,
      });

      this.send(envelope);
    });
  }

  /** Send a notification (no id, no response expected). */
  notify(method: string, params: unknown = {}): void {
    if (this.closed) return;
    this.send({ method, params });
  }

  /** Detach from the child without killing it. Fails pending requests. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failPending("client closed");
  }

  private send(envelope: Envelope): void {
    const line = JSON.stringify(envelope);
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      // Do not send oversized lines; fail fast client-side.
      const id = envelope.id;
      if (id) {
        const p = this.pending.get(id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(id);
          p.reject(new RpcErrorImpl("INVALID_REQUEST", `request exceeds ${MAX_LINE_BYTES} bytes`, undefined, id));
        }
      }
      return;
    }
    this.child.stdin!.write(line + "\n");
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.trim().length === 0) continue;
      this.handleLine(line);
    }
    // Guard against unbounded buffering of a malicious/buggy stream.
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.buffer = "";
      this.opts.onProtocolError?.({
        code: "INVALID_REQUEST",
        message: `unterminated line exceeds ${MAX_LINE_BYTES} bytes`,
      });
    }
  }

  private handleLine(line: string): void {
    let env: Envelope;
    try {
      env = JSON.parse(line) as Envelope;
    } catch (e) {
      this.opts.onProtocolError?.({
        code: "PARSE_ERROR",
        message: `unparseable line from core: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }

    // Responses correlate to pending requests; anything else is unexpected.
    if (env.id !== undefined) {
      const p = this.pending.get(env.id);
      if (!p) {
        this.opts.onProtocolError?.({
          code: "INTERNAL",
          message: `response for unknown request id: ${env.id}`,
        });
        return;
      }
      this.pending.delete(env.id);
      clearTimeout(p.timer);
      if (env.error) {
        p.reject(
          new RpcErrorImpl(env.error.code, env.error.message, env.error.details, env.error.request_id ?? env.id),
        );
      } else {
        p.resolve(env);
      }
      return;
    }

    // Notifications from the core are reserved for later parts (progress etc.).
    this.opts.onProtocolError?.({
      code: "INTERNAL",
      message: `unexpected notification from core: ${env.method ?? "?"}`,
    });
  }
}
