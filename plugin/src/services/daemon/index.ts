/**
 * Daemon facade: owns the full core lifecycle — find binary, spawn, connect,
 * health check, restart, graceful stop.
 *
 * This is the single object the rest of the plugin (and later, Obsidian
 * lifecycle hooks) talks to. UI concerns stay out of here entirely.
 */

import { CoreClient, DEFAULT_REQUEST_TIMEOUT_MS } from "./client";
import { CoreProcess, SpawnOptions, spawnCore, stopCore } from "./spawn";
import { HealthResult, RpcErrorImpl } from "../../types/protocol";

export interface DaemonOptions {
  /** Absolute path to the sovereign-core binary. */
  binaryPath: string;
  /** Root directory for core state. */
  dataDir: string;
  /** Per-request timeout; defaults to DEFAULT_REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number;
  /** Called when the core exits without being asked to. */
  onUnexpectedExit?: (code: number | null, signal: string | null) => void;
  /** Called with the core's stderr log lines. */
  onLog?: (line: string) => void;
}

/** Connection state of the daemon. */
export type DaemonStatus = "stopped" | "starting" | "running" | "crashed";

export class SovereignDaemon {
  private proc: CoreProcess | null = null;
  private client: CoreClient | null = null;
  private status: DaemonStatus = "stopped";
  private startPromise: Promise<HealthResult> | null = null;

  constructor(private readonly opts: DaemonOptions) {}

  getStatus(): DaemonStatus {
    return this.status;
  }

  /** The active client, or null when not running. */
  getClient(): CoreClient | null {
    return this.client;
  }

  /**
   * Spawn the core (or reuse an in-flight start) and verify it with
   * `core.health`. Resolves with the health result, rejects on failure.
   */
  start(): Promise<HealthResult> {
    if (this.status === "running" && this.client) {
      // Already running: answer with a live health check.
      return this.request<HealthResult>("core.health");
    }
    if (this.startPromise) return this.startPromise;

    this.status = "starting";
    this.startPromise = (async () => {
      try {
        const spawnOpts: SpawnOptions = {
          binaryPath: this.opts.binaryPath,
          paths: { dataDir: this.opts.dataDir },
          onLog: (line) => this.opts.onLog?.(line),
          onUnexpectedExit: (code, signal) => {
            const wasRunning = this.status === "running" || this.status === "starting";
            this.cleanupClient();
            this.status = wasRunning ? "crashed" : "stopped";
            if (wasRunning) this.opts.onUnexpectedExit?.(code, signal);
          },
        };
        const proc = spawnCore(spawnOpts);
        this.proc = proc;

        const client = new CoreClient(proc.child, {
          onProtocolError: () => {
            /* surfaced via request failures; reserved for future telemetry-free diagnostics */
          },
        });
        proc.exit.then(() => client.failPending("core exited"));
        this.client = client;

        const health = await client.request<HealthResult>(
          "core.health",
          {},
          this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        );
        this.status = "running";
        return health;
      } catch (err) {
        await this.stop().catch(() => undefined);
        this.status = "stopped";
        this.startPromise = null;
        throw err instanceof RpcErrorImpl
          ? err
          : new RpcErrorImpl("INTERNAL", err instanceof Error ? err.message : String(err));
      }
    })();

    return this.startPromise;
  }

  /** Send a request through the active client. Rejects if not running. */
  request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    if (!this.client) {
      return Promise.reject(new RpcErrorImpl("INTERNAL", `core not running (status: ${this.status})`));
    }
    return this.client.request<T>(method, params, timeoutMs);
  }

  /** Restart the core process, preserving options. */
  async restart(): Promise<HealthResult> {
    await this.stop();
    return this.start();
  }

  /** Graceful shutdown of the core; safe to call multiple times. */
  async stop(): Promise<void> {
    const proc = this.proc;
    const client = this.client;
    this.proc = null;
    this.client = null;
    this.status = "stopped";
    this.startPromise = null;
    if (client) client.close();
    if (proc) await stopCore(proc);
  }

  private cleanupClient(): void {
    if (this.client) {
      this.client.close();
      this.client = null;
    }
    this.proc = null;
  }
}
