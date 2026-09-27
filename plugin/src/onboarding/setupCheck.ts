/**
 * Setup checks (Workstream: first-run wizard). Pure helpers that summarize
 * the environment for the wizard screens — no DOM, no Notices, fully
 * unit-testable. The wizard turns these summaries into UI.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ModelStatus } from "../vault/types";

// ---------------------------------------------------------------------------
// Core binary detection
// ---------------------------------------------------------------------------

export interface BinaryCheck {
  /** An executable binary was found. */
  ok: boolean;
  /** Absolute path when found, otherwise the best guess that was tried. */
  path: string;
  /** Human explanation for the wizard screen. */
  message: string;
}

/**
 * Candidate locations for the sovereign-core binary, relative to the plugin
 * directory (mirrors services/daemon/spawn.ts default candidates).
 */
export function coreBinaryCandidates(pluginDir: string): string[] {
  const sep = path.sep;
  return [
    path.join(pluginDir, "..", "..", "core", "target", "release", "sovereign-core"),
    path.join(pluginDir, "..", "..", "core", "target", "debug", "sovereign-core"),
    path.join(pluginDir, "bin", `sovereign-core${sep === "\\" ? ".exe" : ""}`),
  ];
}

/** Probe a specific path for an executable file. */
export function probeBinaryPath(candidate: string): BinaryCheck {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return {
      ok: true,
      path: candidate,
      message: "Found the Sovereign core binary.",
    };
  } catch {
    return {
      ok: false,
      path: candidate,
      message:
        "Not found. Build it with scripts/build.sh (Rust required), or enter the path manually.",
    };
  }
}

/** First candidate that exists and is executable, else a not-found summary. */
export function detectCoreBinary(pluginDir: string): BinaryCheck {
  for (const candidate of coreBinaryCandidates(pluginDir)) {
    const result = probeBinaryPath(candidate);
    if (result.ok) return result;
  }
  const firstGuess = coreBinaryCandidates(pluginDir)[0] ?? "";
  return {
    ok: false,
    path: firstGuess,
    message:
      "The sovereign-core binary was not detected. Build it with scripts/build.sh, " +
      "or point the plugin at an existing binary below.",
  };
}

// ---------------------------------------------------------------------------
// Model status summary (honest, from the core's own models.status)
// ---------------------------------------------------------------------------

export interface ModelSummary {
  /** `hash` (built-in, zero setup) or `cli` (user-supplied binary+GGUF). */
  provider: string;
  /** True when the built-in hash embedder is in use. */
  builtin: boolean;
  /** Chunks with embeddings vs total, when the core has indexed anything. */
  embedded: number;
  total: number;
  /** Up-front validation error from a misconfigured CLI model, if any. */
  problem?: string;
  /** One-paragraph honest explanation for the wizard. */
  message: string;
}

/** Summarize the core's `models.status` reply for the wizard screen. */
export function summarizeModelStatus(status: ModelStatus): ModelSummary {
  const builtin = status.provider === "hash";
  const problem = status.validation_error || undefined;
  const message = builtin
    ? "Using the built-in deterministic embedder. It needs no model files, " +
      "works fully offline, and powers hybrid search right now. Generation " +
      "answers come from the evidence summary; you can plug in a local GGUF " +
      "model later in settings."
    : problem
      ? `A local CLI model is configured but not working: ${problem}. Search ` +
        "automatically falls back to lexical mode until it is fixed."
      : `Using your local model (${status.model_path ?? "path not reported"}). ` +
        "Everything stays on this machine.";
  return {
    provider: status.provider,
    builtin,
    embedded: status.chunks_embedded,
    total: status.chunks_total,
    problem,
    message,
  };
}

/** The summary shown when the core is offline (honest, not decorative). */
export function offlineModelSummary(): ModelSummary {
  return {
    provider: "unknown",
    builtin: true,
    embedded: 0,
    total: 0,
    message:
      "The core is not running, so model status is unavailable. Finish setup; " +
      "the wizard starts the core when possible.",
  };
}
