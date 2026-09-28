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

/**
 * Where the plugin may live, for dev and symlinked layouts.
 *
 * Obsidian reports `manifest.dir` as a *vault-relative* path, so the caller
 * must make it absolute before searching: a relative path is resolved against
 * Obsidian's own working directory, never matches, and the core silently never
 * starts (the "Sovereign core is not running" failure mode).
 */
export interface BinarySearchRoots {
  pluginDir: string;
  /** Absolute vault root, when known (desktop FileSystemAdapter). */
  vaultRoot?: string | null;
}

/** Candidate paths, most likely first; deduplicated, order preserved. */
export function defaultBinaryCandidates(roots: BinarySearchRoots): string[] {
  const { pluginDir, vaultRoot } = roots;
  const exe = process.platform === "win32" ? ".exe" : "";
  const out: string[] = [];
  const push = (candidate: string | null | undefined): void => {
    if (candidate && candidate.length > 0 && !out.includes(candidate)) out.push(candidate);
  };

  const rootsToTry = [pluginDir];
  try {
    // A symlinked plugin folder (usual development setup: repo/plugin linked
    // into <vault>/.obsidian/plugins/<id>) only reveals the repo layout
    // through its real path.
    const real = fs.realpathSync(pluginDir);
    if (real !== pluginDir) rootsToTry.push(real);
  } catch {
    // Not resolvable; the literal path is enough.
  }

  for (const root of rootsToTry) {
    // The installer drops the binary next to the bundle.
    push(path.join(root, "bin", `sovereign-core${exe}`));
    push(path.join(root, `sovereign-core${exe}`));
    // Development: plugin folder inside the repo checkout.
    for (const up of [path.join("..", ".."), path.join("..", "..", "..")]) {
      push(path.join(root, up, "core", "target", "release", `sovereign-core${exe}`));
      push(path.join(root, up, "core", "target", "debug", `sovereign-core${exe}`));
    }
  }

  if (vaultRoot) {
    // Vault living inside the repo checkout (…/repo/vault).
    for (const up of ["..", path.join("..", ".."), path.join("..", "..", "..")]) {
      push(path.join(vaultRoot, up, "core", "target", "release", `sovereign-core${exe}`));
      push(path.join(vaultRoot, up, "core", "target", "debug", `sovereign-core${exe}`));
    }
    push(
      path.join(
        vaultRoot,
        ".obsidian",
        "plugins",
        "sovereign-second-brain",
        "bin",
        `sovereign-core${exe}`,
      ),
    );
  }

  return out;
}

/** Resolution outcome including every path that was tried. */
export interface BinaryResolution {
  /** Absolute path to an executable core binary, or null when none was found. */
  path: string | null;
  /** Every candidate that was checked, in order (used for honest errors). */
  searched: string[];
}

/** Resolve the core binary, reporting the search space on failure. */
export function resolveCoreBinaryDetailed(roots: BinarySearchRoots): BinaryResolution {
  const searched = defaultBinaryCandidates(roots);
  for (const candidate of searched) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return { path: candidate, searched };
    } catch {
      // keep looking
    }
  }
  return { path: null, searched };
}

/** First existing candidate, or null. */
export function resolveCoreBinary(roots: BinarySearchRoots): string | null {
  return resolveCoreBinaryDetailed(roots).path;
}
