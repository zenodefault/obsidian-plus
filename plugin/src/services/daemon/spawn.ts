/**
 * Daemon lifecycle management for the Sovereign Core child process.
 *
 * Owns spawning, health checking, restart and graceful shutdown of the core.
 * Request/response plumbing lives in `services/daemon/client.ts`.
 */

import { spawn, ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Where the core state (database, models, logs) lives on disk. */
export interface CorePaths {
  dataDir: string;
}

/** Options controlling how the core binary is launched. */
export interface SpawnOptions {
  /** Absolute path to the `sovereign-core` binary. */
  binaryPath: string;
  paths: CorePaths;
  /** Log lines from the core's stderr go here (privacy: never note content). */
  onLog?: (line: string) => void;
  /** Called when the core exits unexpectedly (crash, kill, EOF). */
  onUnexpectedExit?: (code: number | null, signal: string | null) => void;
  /** Hard ceiling on graceful shutdown before the child is killed. */
  killTimeoutMs?: number;
}

/** A running core child process with its stdio pipes. */
export interface CoreProcess {
  child: ChildProcess;
  /** Promise resolving to the exit info; never rejects. */
  exit: Promise<{ code: number | null; signal: string | null }>;
}

/**
 * Spawn the core binary. Throws if the binary is missing or not executable,
 * so callers can surface a precise setup error instead of a hang.
 */
export function spawnCore(opts: SpawnOptions): CoreProcess {
  if (!fs.existsSync(opts.binaryPath)) {
    throw new Error(`core binary not found: ${opts.binaryPath}`);
  }

  const child = spawn(opts.binaryPath, ["--data-dir", opts.paths.dataDir], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && opts.onLog) opts.onLog(trimmed);
    }
  });

  child.on("error", (err) => {
    // Spawn failures (ENOENT, EACCES) surface here after spawn() returns.
    opts.onLog?.(`core spawn error: ${err.message}`);
  });

  exit.then(({ code, signal }) => {
    // Graceful shutdown uses an explicit stop; anything else is unexpected.
    if (signal !== "SIGTERM") opts.onUnexpectedExit?.(code, signal);
  });

  return { child, exit };
}

/**
 * Graceful shutdown: SIGTERM first, then SIGKILL after the timeout.
 * Resolves once the process is definitely gone.
 */
export async function stopCore(proc: CoreProcess, killTimeoutMs = 3000): Promise<void> {
  const { child } = proc;
  if (child.exitCode !== null || child.signalCode !== null) {
    await proc.exit;
    return;
  }

  const exited = proc.exit.then(() => undefined);
  let killed = false;

  const timer = setTimeout(() => {
    killed = true;
    child.kill("SIGKILL");
  }, killTimeoutMs);

  child.kill("SIGTERM");
  await exited;
  clearTimeout(timer);
  void killed;
}

/** Default search locations for the core binary, relative to the plugin dir. */
export function defaultBinaryCandidates(pluginDir: string): string[] {
  const sep = path.sep;
  return [
    path.join(pluginDir, "..", "..", "core", "target", "release", "sovereign-core"),
    path.join(pluginDir, "..", "..", "core", "target", "debug", "sovereign-core"),
    path.join(pluginDir, "bin", `sovereign-core${sep === "\\" ? ".exe" : ""}`),
  ];
}

/** First existing candidate, or null. */
export function resolveCoreBinary(pluginDir: string): string | null {
  for (const candidate of defaultBinaryCandidates(pluginDir)) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}
