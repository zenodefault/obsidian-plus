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
  const gen = status.generation_model
    ? ` Answers are drafted locally by ${status.generation_model}.`
    : status.generation_error
      ? ` The generation model is misconfigured (${status.generation_error}); answers come from note evidence until it is fixed.`
      : "";
  const message = builtin
    ? "Using the built-in deterministic embedder. It needs no model files, " +
      "works fully offline, and powers hybrid search right now." + gen +
      " You can plug in a local GGUF model later in settings."
    : problem
      ? `A local CLI model is configured but not working: ${problem}. Search ` +
        "automatically falls back to lexical mode until it is fixed." + gen
      : `Using your local model (${status.model_path ?? "path not reported"}). ` +
        "Everything stays on this machine." + gen;
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

// ---------------------------------------------------------------------------
// Ollama (local LLM server) detection + linking summaries
// ---------------------------------------------------------------------------

/** Default local Ollama endpoint. Configurable via OLLAMA_HOST. */
export const OLLAMA_DEFAULT_PORT = 11434;

/**
 * Resolve the Ollama base URL from the environment (OLLAMA_HOST honors
 * ollama's own convention: "host", "host:port", "http(s)://host:port").
 */
export function ollamaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const host = (env.OLLAMA_HOST ?? "").trim();
  if (!host) return `http://127.0.0.1:${OLLAMA_DEFAULT_PORT}`;
  if (/^https?:\/\//.test(host)) return host.replace(/\/+$/, "");
  return `http://${host}`.replace(/\/+$/, "");
}

export interface OllamaTag {
  name: string;
  size_bytes: number;
  /** true when the model produces embeddings (family/digest heuristics aside,
   * Ollama reports families; embed models are usually small and non-chat). */
  families?: string[] | null;
}

export interface OllamaInstance {
  baseUrl: string;
  models: OllamaTag[];
}

/**
 * Pick the EMBEDDING model to link automatically: prefer a known embedding
 * model, then any small non-chat model; never a chat model (chat families
 * make poor embedding models and re-embedding the whole vault on a chat
 * model is a mistake). Empty when nothing sensible is found.
 */
export function pickEmbeddingModel(models: OllamaTag[]): OllamaTag | null {
  const EMBED_PATTERNS = [
    /embed/i,
    /e5/i,
    /gte/i,
    /bge/i,
    /minilm/i,
    /nomic/i,
    /snowflake/i,
  ];
  const CHAT_HINT = /(chat|instruct|llama|qwen|mistral|gemma|phi|deepseek|command)/i;
  const byEmbed = models.filter((m) => EMBED_PATTERNS.some((p) => p.test(m.name)));
  if (byEmbed.length > 0) {
    // Smallest embedding model wins (fastest full-vault re-embed).
    return byEmbed.sort((a, b) => a.size_bytes - b.size_bytes)[0] ?? null;
  }
  const nonChat = models.filter((m) => !CHAT_HINT.test(m.name));
  if (nonChat.length > 0) {
    return nonChat.sort((a, b) => a.size_bytes - b.size_bytes)[0] ?? null;
  }
  return null;
}

/**
 * Pick the GENERATION model (the chat model that drafts grounded answers):
 * any installed model qualifies — with only a chat model running, this is
 * what makes the link succeed at all. Never returns a model that the strict
 * embedding picker would choose, so one model is never double-booked.
 * Preference: known chat/instruct families, then whatever is smallest.
 * Empty when no distinct model exists.
 */
export function pickGenerationModel(models: OllamaTag[]): OllamaTag | null {
  if (models.length === 0) return null;
  const embedPick = pickEmbeddingModel(models)?.name;
  const candidates = embedPick ? models.filter((m) => m.name !== embedPick) : models;
  if (candidates.length === 0) return null;
  const CHAT_PATTERN = /(chat|instruct|llama|qwen|mistral|gemma|phi|deepseek|command)/i;
  const byChat = candidates.filter((m) => CHAT_PATTERN.test(m.name));
  const pool = byChat.length > 0 ? byChat : candidates;
  return pool.sort((a, b) => a.size_bytes - b.size_bytes)[0] ?? null;
}

/**
 * Build the shim launcher source. The shim is a tiny Python 3 script the
 * PLUGIN installs into the core's data dir; the core spawns it as the
 * user-configured "model binary". It forwards requests to the local Ollama
 * server — keeping every network byte out of the core process itself
 * (§96: the core owns no sockets; the shim is the user-supplied binary).
 *
 * Wire contract = the core's CLI provider contract, verbatim:
 * stdin `{"model": tag, "texts": [...]}` → stdout `{"embeddings": [[...]]}`
 * stdin `{"model": tag, "prompt": "..."}` → stdout `{"text": "..."}`
 */
export function buildOllamaShimSource(baseUrl: string): string {
  // NOTE: baseUrl is interpolated via repr() escaping; json.dumps is used
  // inside the script for all request payloads.
  const quoted = JSON.stringify(baseUrl);
  return `#!/usr/bin/env python3
"""Sovereign Second Brain local-model shim (generated by the plugin).

Speaks the core's stdio JSON contract on stdin/stdout and forwards to the
user's local Ollama server. No files are written; no other host is contacted.
"""
import json
import sys
import urllib.request

BASE_URL = ${quoted}
TIMEOUT_S = 600


def _post(path: str, payload: dict) -> dict:
    req = urllib.request.Request(
        BASE_URL.rstrip("/") + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> int:
    try:
        req = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        print(json.dumps({"error": "shim received malformed JSON"}))
        return 1

    try:
        if "texts" in req and isinstance(req["texts"], list):
            out = _post("/api/embed", {"model": req.get("model"), "input": req["texts"]})
            embs = out.get("embeddings")
            if embs is None:
                # Older servers: one response per input.
                embs = []
                for text in req["texts"]:
                    single = _post("/api/embeddings", {"model": req.get("model"), "prompt": text})
                    embs.append(single.get("embedding") or [])
            print(json.dumps({"embeddings": embs}))
        elif "prompt" in req:
            out = _post("/api/generate", {
                "model": req.get("model"),
                "prompt": req["prompt"],
                "stream": False,
                # Qwen3 otherwise commonly returns its internal reasoning in
                # the visible answer. This is ignored by older Ollama servers.
                "think": False,
                # Sovereign answers are concise and source-backed. Capping the
                # completion keeps a small local model responsive.
                "options": {"num_predict": 400, "temperature": 0.2, "num_ctx": 8192},
            })
            text = out.get("response", "") or ""
            # Older servers ignore "think": false and let the reasoning
            # monologue stream into the answer — strip any <think> block
            # (closed or trailing-unclosed) so only the answer survives.
            while "<think>" in text and "</think>" in text:
                start = text.index("<think>")
                end = text.index("</think>") + len("</think>")
                text = text[:start] + text[end:]
            if "<think>" in text:
                text = text[: text.index("<think>")]
            text = text.replace("</think>", "").strip()
            print(json.dumps({"text": text}))
        else:
            print(json.dumps({"error": "shim request missing 'texts'/'prompt'"}))
            return 1
        return 0
    except Exception as exc:  # noqa: BLE001 - reported as model runtime failure upstream
        print(json.dumps({"error": f"ollama shim: {exc}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
`;
}

/** Name of the shim file inside the core data dir. */
export const OLLAMA_SHIM_NAME = "sovereign-ollama-shim";

/** Probe result for the shim installation (existence + executability). */
export function shimState(dataDir: string): { path: string; installed: boolean } {
  const p = path.join(dataDir, OLLAMA_SHIM_NAME);
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return { path: p, installed: true };
  } catch {
    return { path: p, installed: false };
  }
}

/** Where the shim and its marker live: the core's own data dir. */
export function shimPathFor(dataDir: string): string {
  return path.join(dataDir, OLLAMA_SHIM_NAME);
}

/**
 * Install (or refresh) the shim launcher into the core data dir. Returns
 * the absolute shim path. Throws on real filesystem errors — the caller
 * surfaces them honestly rather than pretending the link worked.
 */
export function installShim(dataDir: string, baseUrl: string): string {
  fs.mkdirSync(dataDir, { recursive: true });
  const shimPath = shimPathFor(dataDir);
  const source = buildOllamaShimSource(baseUrl);
  const marker = `${shimPath}.base-url`;

  const existing = shimState(dataDir);
  const unchanged =
    existing.installed &&
    fs.existsSync(marker) &&
    fs.readFileSync(marker, "utf8").trim() === baseUrl &&
    fs.readFileSync(shimPath, "utf8") === source;
  if (unchanged) return shimPath;

  fs.writeFileSync(shimPath, source, { mode: 0o755 });
  fs.chmodSync(shimPath, 0o755); // umask can strip the exec bit on some systems
  fs.writeFileSync(marker, `${baseUrl}\n`, { mode: 0o644 });

  if (process.platform === "win32") {
    // POSIX exec bits mean nothing on Windows; install a launcher sibling
    // (trying the `py` launcher first, then python) so Command::new works.
    fs.writeFileSync(
      `${shimPath}.cmd`,
      [
        "@echo off",
        'py "%~dp0sovereign-ollama-shim" %* 2>nul || python "%~dp0sovereign-ollama-shim" %*',
      ].join("\r\n"),
      { mode: 0o755 },
    );
  }
  return shimPath;
}
