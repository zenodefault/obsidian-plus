"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/onboarding/setupCheck.ts
function coreBinaryCandidates(pluginDir) {
  const sep2 = path2.sep;
  return [
    path2.join(pluginDir, "..", "..", "core", "target", "release", "sovereign-core"),
    path2.join(pluginDir, "..", "..", "core", "target", "debug", "sovereign-core"),
    path2.join(pluginDir, "bin", `sovereign-core${sep2 === "\\" ? ".exe" : ""}`)
  ];
}
function probeBinaryPath(candidate) {
  try {
    fs2.accessSync(candidate, fs2.constants.X_OK);
    return {
      ok: true,
      path: candidate,
      message: "Found the Sovereign core binary."
    };
  } catch {
    return {
      ok: false,
      path: candidate,
      message: "Not found. Build it with scripts/build.sh (Rust required), or enter the path manually."
    };
  }
}
function detectCoreBinary(pluginDir) {
  for (const candidate of coreBinaryCandidates(pluginDir)) {
    const result = probeBinaryPath(candidate);
    if (result.ok) return result;
  }
  const firstGuess = coreBinaryCandidates(pluginDir)[0] ?? "";
  return {
    ok: false,
    path: firstGuess,
    message: "The sovereign-core binary was not detected. Build it with scripts/build.sh, or point the plugin at an existing binary below."
  };
}
function summarizeModelStatus(status) {
  const builtin = status.provider === "hash";
  const problem = status.validation_error || void 0;
  const gen = status.generation_model ? ` Answers are drafted locally by ${status.generation_model}.` : status.generation_error ? ` The generation model is misconfigured (${status.generation_error}); answers come from note evidence until it is fixed.` : "";
  const message = builtin ? "Using the built-in deterministic embedder. It needs no model files, works fully offline, and powers hybrid search right now." + gen + " You can plug in a local GGUF model later in settings." : problem ? `A local CLI model is configured but not working: ${problem}. Search automatically falls back to lexical mode until it is fixed.` + gen : `Using your local model (${status.model_path ?? "path not reported"}). Everything stays on this machine.` + gen;
  return {
    provider: status.provider,
    builtin,
    embedded: status.chunks_embedded,
    total: status.chunks_total,
    problem,
    message
  };
}
function offlineModelSummary() {
  return {
    provider: "unknown",
    builtin: true,
    embedded: 0,
    total: 0,
    message: "The core is not running, so model status is unavailable. Finish setup; the wizard starts the core when possible."
  };
}
function ollamaBaseUrl(env = process.env) {
  const host = (env.OLLAMA_HOST ?? "").trim();
  if (!host) return `http://127.0.0.1:${OLLAMA_DEFAULT_PORT}`;
  if (/^https?:\/\//.test(host)) return host.replace(/\/+$/, "");
  return `http://${host}`.replace(/\/+$/, "");
}
function pickEmbeddingModel(models) {
  const EMBED_PATTERNS = [
    /embed/i,
    /e5/i,
    /gte/i,
    /bge/i,
    /minilm/i,
    /nomic/i,
    /snowflake/i
  ];
  const CHAT_HINT = /(chat|instruct|llama|qwen|mistral|gemma|phi|deepseek|command)/i;
  const byEmbed = models.filter((m) => EMBED_PATTERNS.some((p) => p.test(m.name)));
  if (byEmbed.length > 0) {
    return byEmbed.sort((a, b) => a.size_bytes - b.size_bytes)[0] ?? null;
  }
  const nonChat = models.filter((m) => !CHAT_HINT.test(m.name));
  if (nonChat.length > 0) {
    return nonChat.sort((a, b) => a.size_bytes - b.size_bytes)[0] ?? null;
  }
  return null;
}
function pickGenerationModel(models) {
  if (models.length === 0) return null;
  const embedPick = pickEmbeddingModel(models)?.name;
  const candidates = embedPick ? models.filter((m) => m.name !== embedPick) : models;
  if (candidates.length === 0) return null;
  const CHAT_PATTERN = /(chat|instruct|llama|qwen|mistral|gemma|phi|deepseek|command)/i;
  const byChat = candidates.filter((m) => CHAT_PATTERN.test(m.name));
  const pool = byChat.length > 0 ? byChat : candidates;
  return pool.sort((a, b) => a.size_bytes - b.size_bytes)[0] ?? null;
}
function buildOllamaShimSource(baseUrl) {
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
TIMEOUT_S = 120


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
                "options": {"num_predict": 220, "temperature": 0.2},
            })
            print(json.dumps({"text": out.get("response", "")}))
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
function shimState(dataDir) {
  const p = path2.join(dataDir, OLLAMA_SHIM_NAME);
  try {
    fs2.accessSync(p, fs2.constants.X_OK);
    return { path: p, installed: true };
  } catch {
    return { path: p, installed: false };
  }
}
function shimPathFor(dataDir) {
  return path2.join(dataDir, OLLAMA_SHIM_NAME);
}
function installShim(dataDir, baseUrl) {
  fs2.mkdirSync(dataDir, { recursive: true });
  const shimPath = shimPathFor(dataDir);
  const source = buildOllamaShimSource(baseUrl);
  const marker = `${shimPath}.base-url`;
  const existing = shimState(dataDir);
  const unchanged = existing.installed && fs2.existsSync(marker) && fs2.readFileSync(marker, "utf8").trim() === baseUrl && fs2.readFileSync(shimPath, "utf8") === source;
  if (unchanged) return shimPath;
  fs2.writeFileSync(shimPath, source, { mode: 493 });
  fs2.chmodSync(shimPath, 493);
  fs2.writeFileSync(marker, `${baseUrl}
`, { mode: 420 });
  if (process.platform === "win32") {
    fs2.writeFileSync(
      `${shimPath}.cmd`,
      [
        "@echo off",
        'py "%~dp0sovereign-ollama-shim" %* 2>nul || python "%~dp0sovereign-ollama-shim" %*'
      ].join("\r\n"),
      { mode: 493 }
    );
  }
  return shimPath;
}
var fs2, path2, OLLAMA_DEFAULT_PORT, OLLAMA_SHIM_NAME;
var init_setupCheck = __esm({
  "src/onboarding/setupCheck.ts"() {
    "use strict";
    fs2 = __toESM(require("node:fs"));
    path2 = __toESM(require("node:path"));
    OLLAMA_DEFAULT_PORT = 11434;
    OLLAMA_SHIM_NAME = "sovereign-ollama-shim";
  }
});

// src/services/ollama.ts
var ollama_exports = {};
__export(ollama_exports, {
  OLLAMA_WATCH_INTERVAL_MS: () => OLLAMA_WATCH_INTERVAL_MS,
  autoLinkCheck: () => autoLinkCheck,
  linkOllamaToCore: () => linkOllamaToCore,
  probeOllama: () => probeOllama,
  verifyShim: () => verifyShim
});
async function probeOllama(baseUrl = ollamaBaseUrl()) {
  try {
    const res = await (0, import_obsidian.requestUrl)({
      url: `${baseUrl}/api/tags`,
      method: "GET",
      throw: false
    });
    if (res.status !== 200) {
      return { found: false, baseUrl, reason: `HTTP ${res.status} from ${baseUrl}/api/tags` };
    }
    const body = res.json;
    const models = (body.models ?? []).filter((m) => typeof m.name === "string" && m.name.length > 0).map((m) => ({ name: m.name, size_bytes: typeof m.size === "number" ? m.size : 0, families: m.families ?? null }));
    return { found: true, baseUrl, models };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { found: false, baseUrl, reason };
  }
}
function verifyShim(dataDir, model, role = "embed") {
  const shimPath = shimPathFor(dataDir);
  if (process.platform !== "win32" && !shimState(dataDir).installed) {
    return Promise.resolve({ ok: false, reason: `shim not installed or not executable: ${shimPath}` });
  }
  return new Promise((resolve2) => {
    let settled = false;
    const done = (r) => {
      if (!settled) {
        settled = true;
        resolve2(r);
      }
    };
    const { spawn: spawn2 } = require("node:child_process");
    const bin = process.platform === "win32" ? `${shimPath}.cmd` : shimPath;
    const proc = spawn2(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      done({ ok: false, reason: "shim did not answer within 15s (is python3 on PATH?)" });
    }, 15e3);
    let out = "";
    proc.stdout?.on("data", (c) => out += c.toString("utf8"));
    proc.on("error", (err) => {
      clearTimeout(timer);
      done({ ok: false, reason: `failed to launch shim: ${err.message}` });
    });
    proc.on("exit", () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out);
        if (parsed.error) {
          done({ ok: false, reason: parsed.error });
          return;
        }
        if (role === "generate") {
          const text = parsed.text ?? "";
          if (text.length > 0) done({ ok: true, dimension: 0 });
          else done({ ok: false, reason: "shim returned an empty completion" });
          return;
        }
        const dim = parsed.embeddings?.[0]?.length ?? 0;
        if (dim > 0) done({ ok: true, dimension: dim });
        else done({ ok: false, reason: "shim returned an empty embedding" });
      } catch {
        done({ ok: false, reason: "shim produced unparseable output" });
      }
    });
    proc.stdin?.end(
      role === "generate" ? JSON.stringify({ model, prompt: "Reply with the single word: ok" }) : JSON.stringify({ model, texts: ["sovereign shim verification"] })
    );
  });
}
async function linkOllamaToCore(instance, ctx) {
  const { baseUrl } = instance;
  const embedModel = pickEmbeddingModel(instance.models);
  const genModel = pickGenerationModel(instance.models);
  if (!embedModel && !genModel) {
    return {
      linked: false,
      baseUrl,
      message: "Ollama is running but no suitable model is installed. Pull a model (e.g. `ollama pull qwen3:4b` for answers, `ollama pull nomic-embed-text` for better search) and the plugin will link it on its next check."
    };
  }
  if (!ctx.dataDir) {
    return { linked: false, baseUrl, message: "Core data directory is not configured yet." };
  }
  let shimPath;
  try {
    shimPath = installShim(ctx.dataDir, baseUrl);
  } catch (err) {
    return {
      linked: false,
      baseUrl,
      message: `Could not install the Ollama shim: ${err instanceof Error ? err.message : String(err)}`
    };
  }
  if (!ctx.request) {
    return { linked: false, baseUrl, message: "Core is offline; the shim is installed but not linked." };
  }
  let embedLinked = false;
  let genLinked = false;
  if (embedModel) {
    try {
      const result = await ctx.request("models.configure", {
        provider: "ollama",
        model_path: embedModel.name,
        binary_path: shimPath,
        base_url: baseUrl
      });
      if (!result.applied) {
        return { linked: false, baseUrl, message: "The core refused the model configuration." };
      }
      if (result.validation_error) {
        return {
          linked: false,
          baseUrl,
          message: `Configuration stored but invalid: ${result.validation_error}`
        };
      }
    } catch (err) {
      return {
        linked: false,
        baseUrl,
        message: `models.configure failed: ${err instanceof Error ? err.message : String(err)}`
      };
    }
    const verify = await verifyShim(ctx.dataDir, embedModel.name);
    if (!verify.ok) {
      return {
        linked: false,
        baseUrl,
        message: `Shim verification failed: ${verify.reason}. Configuration is stored; the core will fall back to lexical search until it works.`
      };
    }
    embedLinked = true;
  }
  if (genModel) {
    try {
      const result = await ctx.request("models.configure", {
        provider: embedModel ? "ollama" : "hash",
        model_path: embedModel?.name,
        binary_path: embedModel ? shimPath : void 0,
        base_url: embedModel ? baseUrl : void 0,
        generation_model_path: genModel.name,
        generation_binary_path: shimPath,
        generation_base_url: baseUrl
      });
      if (!result.applied || result.validation_error) {
        if (embedLinked) {
          return {
            linked: true,
            baseUrl,
            model: embedModel?.name,
            message: `Linked Ollama for search (${embedModel?.name}); the generation model (${genModel.name}) was refused: ${result.validation_error ?? "rejected by the core"}.`
          };
        }
        return {
          linked: false,
          baseUrl,
          message: `Configuration stored but invalid: ${result.validation_error ?? "rejected by the core"}`
        };
      }
    } catch (err) {
      if (embedLinked) {
        return {
          linked: true,
          baseUrl,
          model: embedModel?.name,
          message: `Linked Ollama for search (${embedModel?.name}); the generation model could not be configured: ${err instanceof Error ? err.message : String(err)}`
        };
      }
      return {
        linked: false,
        baseUrl,
        message: `models.configure failed: ${err instanceof Error ? err.message : String(err)}`
      };
    }
    const genVerify = await verifyShim(ctx.dataDir, genModel.name, "generate");
    if (!genVerify.ok) {
      if (embedLinked) {
        return {
          linked: true,
          baseUrl,
          model: embedModel?.name,
          message: `Linked Ollama for search (${embedModel?.name}); the generation model failed verification: ${genVerify.reason}.`
        };
      }
      return {
        linked: false,
        baseUrl,
        message: `Shim verification failed: ${genVerify.reason}. Configuration is stored; answers will come from note evidence until it works.`
      };
    }
    genLinked = true;
  }
  if (embedLinked && genLinked) {
    return {
      linked: true,
      baseUrl,
      model: embedModel?.name,
      embedLinked: true,
      message: `Linked local Ollama (${embedModel?.name} for search, ${genModel?.name} for answers). Re-embedding the vault with it now.`
    };
  }
  if (embedLinked) {
    return {
      linked: true,
      baseUrl,
      model: embedModel?.name,
      embedLinked: true,
      message: `Linked local Ollama (${embedModel?.name}). Re-embedding the vault with it now.`
    };
  }
  return {
    linked: true,
    baseUrl,
    model: genModel?.name,
    embedLinked: false,
    message: `Linked local Ollama (${genModel?.name}) for answers. Search uses the built-in embedder; pull an embedding model (e.g. nomic-embed-text) for better retrieval.`
  };
}
async function autoLinkCheck(currentProvider, ctx) {
  if (currentProvider === "ollama") return null;
  const probe = await probeOllama();
  if (!probe.found) return null;
  if (!ctx) return null;
  const result = await linkOllamaToCore(probe, ctx);
  return result.linked ? result : null;
}
var import_obsidian, OLLAMA_WATCH_INTERVAL_MS;
var init_ollama = __esm({
  "src/services/ollama.ts"() {
    "use strict";
    import_obsidian = require("obsidian");
    init_setupCheck();
    OLLAMA_WATCH_INTERVAL_MS = 5 * 60 * 1e3;
  }
});

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => SovereignSecondBrainPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian7 = require("obsidian");
var os = __toESM(require("node:os"));
var path3 = __toESM(require("node:path"));

// src/types/protocol.ts
var RpcErrorImpl = class extends Error {
  constructor(code, message, details, requestId) {
    super(message);
    this.code = code;
    this.details = details;
    this.requestId = requestId;
    this.name = "RpcError";
  }
};

// src/services/daemon/client.ts
var MAX_LINE_BYTES = 10 * 1024 * 1024;
var DEFAULT_REQUEST_TIMEOUT_MS = 15e3;
var CoreClient = class {
  constructor(child, opts = {}) {
    this.child = child;
    this.opts = opts;
    this.pending = /* @__PURE__ */ new Map();
    this.nextId = 0;
    this.buffer = "";
    this.closed = false;
    if (!child.stdout || !child.stdin) {
      throw new Error("core child process must have piped stdin/stdout");
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.handleData(chunk));
  }
  /** Fail all pending requests (used on unexpected core exit or client close). */
  failPending(reason) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new RpcErrorImpl("INTERNAL", reason, void 0, id));
    }
    this.pending.clear();
  }
  /** Send a request and await its typed response. Rejects with RpcErrorImpl. */
  request(method, params = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    if (this.closed) {
      return Promise.reject(new RpcErrorImpl("INTERNAL", "client is closed"));
    }
    const id = `req_${++this.nextId}`;
    const envelope = { id, method, params };
    return new Promise((resolve2, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcErrorImpl("INTERNAL", `request timed out after ${timeoutMs}ms: ${method}`, void 0, id));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (env) => resolve2(env.result),
        reject,
        timer
      });
      this.send(envelope);
    });
  }
  /** Send a notification (no id, no response expected). */
  notify(method, params = {}) {
    if (this.closed) return;
    this.send({ method, params });
  }
  /** Detach from the child without killing it. Fails pending requests. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.failPending("client closed");
  }
  send(envelope) {
    const line = JSON.stringify(envelope);
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      const id = envelope.id;
      if (id) {
        const p = this.pending.get(id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(id);
          p.reject(new RpcErrorImpl("INVALID_REQUEST", `request exceeds ${MAX_LINE_BYTES} bytes`, void 0, id));
        }
      }
      return;
    }
    this.child.stdin.write(line + "\n");
  }
  handleData(chunk) {
    this.buffer += chunk;
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.trim().length === 0) continue;
      this.handleLine(line);
    }
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.buffer = "";
      this.opts.onProtocolError?.({
        code: "INVALID_REQUEST",
        message: `unterminated line exceeds ${MAX_LINE_BYTES} bytes`
      });
    }
  }
  handleLine(line) {
    let env;
    try {
      env = JSON.parse(line);
    } catch (e) {
      this.opts.onProtocolError?.({
        code: "PARSE_ERROR",
        message: `unparseable line from core: ${e instanceof Error ? e.message : String(e)}`
      });
      return;
    }
    if (env.id !== void 0) {
      const p = this.pending.get(env.id);
      if (!p) {
        this.opts.onProtocolError?.({
          code: "INTERNAL",
          message: `response for unknown request id: ${env.id}`
        });
        return;
      }
      this.pending.delete(env.id);
      clearTimeout(p.timer);
      if (env.error) {
        p.reject(
          new RpcErrorImpl(env.error.code, env.error.message, env.error.details, env.error.request_id ?? env.id)
        );
      } else {
        p.resolve(env);
      }
      return;
    }
    this.opts.onProtocolError?.({
      code: "INTERNAL",
      message: `unexpected notification from core: ${env.method ?? "?"}`
    });
  }
};

// src/services/daemon/spawn.ts
var import_node_child_process = require("node:child_process");
var fs = __toESM(require("node:fs"));
var path = __toESM(require("node:path"));
function spawnCore(opts) {
  if (!fs.existsSync(opts.binaryPath)) {
    throw new Error(`core binary not found: ${opts.binaryPath}`);
  }
  const child = (0, import_node_child_process.spawn)(opts.binaryPath, ["--data-dir", opts.paths.dataDir], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  const exit = new Promise((resolve2) => {
    child.on("exit", (code, signal) => resolve2({ code, signal }));
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && opts.onLog) opts.onLog(trimmed);
    }
  });
  child.on("error", (err) => {
    opts.onLog?.(`core spawn error: ${err.message}`);
  });
  exit.then(({ code, signal }) => {
    if (signal !== "SIGTERM") opts.onUnexpectedExit?.(code, signal);
  });
  return { child, exit };
}
async function stopCore(proc, killTimeoutMs = 3e3) {
  const { child } = proc;
  if (child.exitCode !== null || child.signalCode !== null) {
    await proc.exit;
    return;
  }
  const exited = proc.exit.then(() => void 0);
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    child.kill("SIGKILL");
  }, killTimeoutMs);
  child.kill("SIGTERM");
  await exited;
  clearTimeout(timer);
}
function defaultBinaryCandidates(roots) {
  const { pluginDir, vaultRoot } = roots;
  const exe = process.platform === "win32" ? ".exe" : "";
  const out = [];
  const push = (candidate) => {
    if (candidate && candidate.length > 0 && !out.includes(candidate)) out.push(candidate);
  };
  const rootsToTry = [pluginDir];
  try {
    const real = fs.realpathSync(pluginDir);
    if (real !== pluginDir) rootsToTry.push(real);
  } catch {
  }
  for (const root of rootsToTry) {
    push(path.join(root, "bin", `sovereign-core${exe}`));
    push(path.join(root, `sovereign-core${exe}`));
    for (const up of [path.join("..", ".."), path.join("..", "..", "..")]) {
      push(path.join(root, up, "core", "target", "release", `sovereign-core${exe}`));
      push(path.join(root, up, "core", "target", "debug", `sovereign-core${exe}`));
    }
  }
  if (vaultRoot) {
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
        `sovereign-core${exe}`
      )
    );
  }
  return out;
}
function resolveCoreBinaryDetailed(roots) {
  const searched = defaultBinaryCandidates(roots);
  for (const candidate of searched) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return { path: candidate, searched };
    } catch {
    }
  }
  return { path: null, searched };
}

// src/services/daemon/index.ts
var SovereignDaemon = class {
  constructor(opts) {
    this.opts = opts;
    this.proc = null;
    this.client = null;
    this.status = "stopped";
    this.startPromise = null;
  }
  getStatus() {
    return this.status;
  }
  /** The active client, or null when not running. */
  getClient() {
    return this.client;
  }
  /**
   * Spawn the core (or reuse an in-flight start) and verify it with
   * `core.health`. Resolves with the health result, rejects on failure.
   */
  start() {
    if (this.status === "running" && this.client) {
      return this.request("core.health");
    }
    if (this.startPromise) return this.startPromise;
    this.status = "starting";
    this.startPromise = (async () => {
      try {
        const spawnOpts = {
          binaryPath: this.opts.binaryPath,
          paths: { dataDir: this.opts.dataDir },
          onLog: (line) => this.opts.onLog?.(line),
          onUnexpectedExit: (code, signal) => {
            const wasRunning = this.status === "running" || this.status === "starting";
            this.cleanupClient();
            this.status = wasRunning ? "crashed" : "stopped";
            if (wasRunning) this.opts.onUnexpectedExit?.(code, signal);
          }
        };
        const proc = spawnCore(spawnOpts);
        this.proc = proc;
        const client = new CoreClient(proc.child, {
          onProtocolError: () => {
          }
        });
        proc.exit.then(() => client.failPending("core exited"));
        this.client = client;
        const health = await client.request(
          "core.health",
          {},
          this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
        );
        this.status = "running";
        return health;
      } catch (err) {
        await this.stop().catch(() => void 0);
        this.status = "stopped";
        this.startPromise = null;
        throw err instanceof RpcErrorImpl ? err : new RpcErrorImpl("INTERNAL", err instanceof Error ? err.message : String(err));
      }
    })();
    return this.startPromise;
  }
  /** Send a request through the active client. Rejects if not running. */
  request(method, params, timeoutMs) {
    if (!this.client) {
      return Promise.reject(new RpcErrorImpl("INTERNAL", `core not running (status: ${this.status})`));
    }
    return this.client.request(method, params, timeoutMs);
  }
  /** Restart the core process, preserving options. */
  async restart() {
    await this.stop();
    return this.start();
  }
  /** Graceful shutdown of the core; safe to call multiple times. */
  async stop() {
    const proc = this.proc;
    const client = this.client;
    this.proc = null;
    this.client = null;
    this.status = "stopped";
    this.startPromise = null;
    if (client) client.close();
    if (proc) await stopCore(proc);
  }
  cleanupClient() {
    if (this.client) {
      this.client.close();
      this.client = null;
    }
    this.proc = null;
  }
};

// src/settings/settings.ts
var DEFAULT_SETTINGS = {
  coreBinaryPath: "",
  dataDir: "",
  requestTimeoutMs: 15e3,
  onboardingComplete: false,
  ollamaAutoLink: true,
  ollamaBaseUrl: "",
  beamSize: "md",
  beamColor: "theme",
  beamStrength: 0.5
};

// src/vault/inventory.ts
var crypto = __toESM(require("node:crypto"));
function hashContent(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}
var INDEXABLE_EXTENSIONS = /* @__PURE__ */ new Set(["md"]);
function shouldIndex(file) {
  return INDEXABLE_EXTENSIONS.has(file.extension.toLowerCase());
}
async function buildInventory(vault, limit) {
  const files = vault.getMarkdownFiles().filter(shouldIndex);
  const selected = limit !== void 0 ? files.slice(0, limit) : files;
  const notes = [];
  for (const file of selected) {
    const content = await vault.cachedRead(file);
    notes.push({
      path: normalizePath(file.path),
      hash: hashContent(content),
      mtime: file.stat.mtime,
      size: file.stat.size
    });
  }
  return notes;
}
async function readNote(vault, path4) {
  const file = vault.getAbstractFileByPath(path4);
  if (!file || !("stat" in file)) {
    throw new Error(`note not found in vault: ${path4}`);
  }
  const tfile = file;
  const content = await vault.read(tfile);
  return {
    path: normalizePath(tfile.path),
    hash: hashContent(content),
    mtime: tfile.stat.mtime,
    size: tfile.stat.size,
    content
  };
}
function normalizePath(path4) {
  return path4.replace(/\\/g, "/").replace(/^\/+/, "");
}
var Debouncer = class {
  constructor(waitMs) {
    this.waitMs = waitMs;
    this.timer = null;
  }
  /** Schedule `fn`; cancels any pending call. Returns true if it replaced one. */
  run(fn) {
    const hadPending = this.timer !== null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      fn();
    }, this.waitMs);
    return hadPending;
  }
  /** Cancel any pending call without running it. */
  cancel() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  get pending() {
    return this.timer !== null;
  }
};

// src/vault/sync.ts
var BATCH_SIZE = 200;
var SyncAbortedError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "SyncAbortedError";
  }
};
async function runSync(deps, inventory, opts = {}) {
  const { rebuild = false, shouldAbort, onProgress } = opts;
  const check = () => {
    if (shouldAbort?.()) throw new SyncAbortedError("sync aborted");
  };
  const begun = await deps.begin(rebuild);
  const session = begun.session_id;
  let received = 0;
  for (let i = 0; i < inventory.length; i += BATCH_SIZE) {
    check();
    const chunk = inventory.slice(i, i + BATCH_SIZE);
    const r = await deps.batch(session, chunk);
    received += r.received;
  }
  onProgress?.("inventory", received, inventory.length);
  check();
  const diff = await deps.commit(session);
  onProgress?.("committed", diff.to_fetch.length, diff.to_fetch.length);
  let uploaded = 0;
  for (const path4 of diff.to_fetch) {
    check();
    const note = await deps.readNote(path4);
    await deps.uploadNote(session, note);
    uploaded += 1;
    onProgress?.("uploading", uploaded, diff.to_fetch.length);
  }
  check();
  const fin = await deps.finish(session);
  return {
    added: diff.added,
    modified: diff.modified,
    renamed: diff.renamed,
    deleted: diff.deleted,
    to_fetch: diff.to_fetch,
    applied: diff.applied,
    totalNotes: fin.total_notes,
    persisted: fin.persisted,
    uploaded
  };
}

// src/vault/attach.ts
var DEFAULT_DEBOUNCE_MS = 1500;
function createVaultWatcher(_vault, deps, debounceMs = DEFAULT_DEBOUNCE_MS) {
  const debouncer = new Debouncer(debounceMs);
  const watcher = (file, oldPath) => {
    const isMarkdown = !("children" in file) && file.extension !== void 0;
    if (!isMarkdown) return;
    if (oldPath !== void 0) {
      deps.scheduleSync();
      return;
    }
    debouncer.run(() => deps.scheduleSync());
  };
  return { watcher, debouncer };
}

// src/settings/SettingTab.ts
var import_obsidian3 = require("obsidian");

// src/onboarding/SetupWizardModal.ts
var import_obsidian2 = require("obsidian");

// src/ui/beam.ts
var BEAM_SIZES = ["md", "sm", "line", "pulse-inner", "pulse-outside"];
var BEAM_COLORS = ["theme", "colorful", "mono", "ocean", "sunset"];
var BEAM_SIZE_LABELS = {
  md: "Beam (medium arc)",
  sm: "Beam (short arc)",
  line: "Hairline (crisp)",
  "pulse-inner": "Pulse (inside)",
  "pulse-outside": "Pulse (outside glow)"
};
var BEAM_COLOR_LABELS = {
  theme: "Theme accent",
  colorful: "Colourful",
  mono: "Monochrome",
  ocean: "Ocean",
  sunset: "Sunset"
};
var clamp01 = (n) => Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.55;
function parseColor(raw) {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(value);
  if (short) {
    return [
      parseInt(short[1] + short[1], 16),
      parseInt(short[2] + short[2], 16),
      parseInt(short[3] + short[3], 16)
    ];
  }
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(value);
  if (long) {
    return [parseInt(long[1], 16), parseInt(long[2], 16), parseInt(long[3], 16)];
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(value);
  if (fn) {
    const parts = fn[1].split(",").map((p) => parseFloat(p));
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      return [parts[0], parts[1], parts[2]];
    }
  }
  return null;
}
function relativeLuminance(rgb) {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function detectBeamTheme(probe) {
  const body = typeof document === "undefined" ? null : document.body;
  if (body?.classList.contains("theme-light")) return "light";
  if (body?.classList.contains("theme-dark")) return "dark";
  const host = probe ?? body;
  if (!host || typeof getComputedStyle !== "function") return "dark";
  const styles = getComputedStyle(host);
  const surface = parseColor(styles.getPropertyValue("--background-primary"));
  const text = parseColor(styles.getPropertyValue("--text-normal"));
  const sample = surface ?? text;
  if (!sample) return "dark";
  return relativeLuminance(sample) > 0.5 ? "light" : "dark";
}
function applyBeam(el, opts = {}) {
  el.dataset.beamSize = opts.size ?? "md";
  el.dataset.beamColor = opts.color ?? "theme";
  el.dataset.beamTheme = detectBeamTheme(el);
  el.dataset.beamActive = opts.active === false ? "false" : "true";
  el.style.setProperty("--sovereign-beam-strength", clamp01(opts.strength ?? 0.55).toFixed(2));
}

// src/onboarding/SetupWizardModal.ts
init_setupCheck();
var STEP_TITLES = [
  "Welcome",
  "Core binary",
  "Data directory",
  "Local models",
  "Vault sync",
  "Done"
];
var SetupWizardModal = class extends import_obsidian2.Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.step = 0;
    this.binaryCheck = null;
    this.modelSummary = null;
    this.syncing = false;
    this.syncDone = false;
  }
  async onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass("sovereign-wizard-modal");
    contentEl.empty();
    const frame = contentEl.createDiv({ cls: "sovereign-overlay-frame" });
    frame.createDiv({ cls: "sovereign-beam-layer" });
    applyBeam(frame, {
      size: this.plugin.settings.beamSize,
      color: this.plugin.settings.beamColor,
      strength: this.plugin.settings.beamStrength,
      active: true
    });
    const header = frame.createDiv({ cls: "sovereign-wizard-header" });
    this.stepIndicatorEl = header.createDiv({ cls: "sovereign-wizard-steps" });
    this.bodyEl = frame.createDiv({ cls: "sovereign-wizard-body" });
    this.footerEl = frame.createDiv({ cls: "sovereign-wizard-footer" });
    this.render();
  }
  onClose() {
    this.contentEl.empty();
    return Promise.resolve();
  }
  // ---- rendering ---------------------------------------------------------
  render() {
    this.renderStepIndicator();
    this.bodyEl.empty();
    this.footerEl.empty();
    switch (this.step) {
      case 0:
        this.renderWelcome();
        break;
      case 1:
        this.renderCoreBinary();
        break;
      case 2:
        this.renderDataDir();
        break;
      case 3:
        void this.renderModels();
        break;
      case 4:
        void this.renderSync();
        break;
      case 5:
        this.renderDone();
        break;
    }
  }
  renderStepIndicator() {
    const el = this.stepIndicatorEl;
    el.empty();
    STEP_TITLES.forEach((title, i) => {
      const chip = el.createSpan({
        cls: `sovereign-wizard-step ${i === this.step ? "is-current" : ""} ${i < this.step ? "is-done" : ""}`
      });
      chip.setText(String(i + 1));
      chip.setAttribute("aria-label", `${i + 1}. ${title}`);
    });
  }
  addTitle(title, subtitle) {
    this.bodyEl.createEl("h3", { text: title, cls: "sovereign-wizard-title" });
    if (subtitle) {
      this.bodyEl.createEl("p", {
        text: subtitle,
        cls: "sovereign-wizard-subtitle"
      });
    }
  }
  addNav(nextLabel, onNext, opts = {}) {
    const row = this.bodyEl.createDiv({ cls: "sovereign-wizard-actions" });
    if (opts.back !== false && this.step > 0) {
      const back = row.createEl("button", { text: "Back", cls: "sovereign-btn-secondary" });
      back.addEventListener("click", () => {
        this.step = this.step - 1;
        this.render();
      });
    }
    const next = row.createEl("button", { text: nextLabel, cls: "mod-cta sovereign-btn-primary" });
    next.addEventListener("click", onNext);
    const skip = row.createEl("button", {
      text: this.step === 4 ? "Skip sync" : "Skip setup",
      cls: "sovereign-wizard-skip"
    });
    skip.addEventListener("click", () => void this.finish());
  }
  // ---- steps ---------------------------------------------------------------
  renderWelcome() {
    this.addTitle(
      "Sovereign Second Brain",
      "A completely local intelligence layer for your vault. Zero cloud, zero telemetry, zero accounts \u2014 the core runs on this machine and talks only to this plugin. Five short steps and you're set."
    );
    const list = this.bodyEl.createDiv({ cls: "sovereign-wizard-list" });
    for (const [k, v] of [
      ["Local core", "A small Rust process indexes and searches your notes."],
      ["Your vault, untouched", "The core never writes files. All changes go through you."],
      ["Memories you approve", "Facts are candidates until you accept them."]
    ]) {
      const row = list.createDiv({ cls: "sovereign-wizard-list-row" });
      row.createSpan({ text: k, cls: "sovereign-wizard-list-key" });
      row.createSpan({ text: v, cls: "sovereign-wizard-list-val" });
    }
    this.addNav("Get started", () => {
      this.step = 1;
      this.render();
    });
  }
  renderCoreBinary() {
    this.addTitle(
      "Core binary",
      "The plugin spawns sovereign-core as a child process. It is detected automatically, or you can point at a specific binary."
    );
    if (!this.binaryCheck) {
      this.binaryCheck = detectCoreBinary(this.plugin.manifest.dir ?? "");
    }
    const check = this.binaryCheck;
    const status = this.bodyEl.createDiv({
      cls: `sovereign-wizard-status ${check.ok ? "is-ok" : "is-warn"}`
    });
    status.createSpan({
      text: check.ok ? `\u2713 ${check.path}` : `\u2715 not found`,
      cls: "sovereign-wizard-status-text"
    });
    this.bodyEl.createEl("p", { text: check.message, cls: "sovereign-wizard-subtitle" });
    new import_obsidian2.Setting(this.bodyEl).setName("Binary path").setDesc("Leave as-is to use the detected path.").addText(
      (text) => text.setPlaceholder(check.path || "path to sovereign-core").setValue(this.plugin.settings.coreBinaryPath).onChange(async (value) => {
        this.plugin.settings.coreBinaryPath = value.trim();
        await this.plugin.saveSettings();
      })
    ).addButton(
      (btn) => btn.setButtonText("Test path").onClick(async () => {
        const candidate = this.plugin.settings.coreBinaryPath || check.path;
        const probe = probeBinaryPath(candidate);
        this.binaryCheck = probe;
        if (probe.ok) {
          new import_obsidian2.Notice("Binary found and executable.");
        } else {
          new import_obsidian2.Notice("That path is not an executable file.");
        }
        this.render();
      })
    );
    this.addNav("Next", () => {
      this.step = 2;
      this.render();
    });
  }
  renderDataDir() {
    this.addTitle(
      "Data directory",
      "Where the core keeps its local state: the SQLite index, vectors and memories. Your vault is only ever read, never written, by the core."
    );
    new import_obsidian2.Setting(this.bodyEl).setName("Data directory").setDesc("Empty means the default: ~/SovereignBrain").addText(
      (text) => text.setPlaceholder("~/SovereignBrain").setValue(this.plugin.settings.dataDir).onChange(async (value) => {
        this.plugin.settings.dataDir = value.trim();
        await this.plugin.saveSettings();
      })
    );
    this.addNav("Next", () => {
      this.step = 3;
      this.render();
    });
  }
  async renderModels() {
    this.addTitle(
      "Local models",
      "Everything runs on this machine. The built-in embedder needs no setup; a local Ollama or GGUF model is optional and can be linked automatically."
    );
    const modelSlot = this.bodyEl.createDiv();
    this.bodyEl.createEl("p", {
      text: "Models are never downloaded by this plugin. A local Ollama server is detected and linked automatically when it is running; otherwise a llama.cpp-style binary and GGUF file can be configured in settings.",
      cls: "sovereign-wizard-footnote"
    });
    const ollamaSlot = this.bodyEl.createDiv();
    this.addNav("Next", () => {
      this.step = 4;
      this.render();
    });
    void this.fillModelStatus(modelSlot);
    await this.renderOllama(ollamaSlot);
  }
  /** Resolve (or reuse) the model summary from the live core. */
  async resolveModelSummary() {
    if (this.modelSummary) return this.modelSummary;
    if (!this.plugin.getDaemon()) {
      await this.plugin.ensureDaemon();
    }
    const daemon = this.plugin.getDaemon();
    if (!daemon) {
      this.modelSummary = offlineModelSummary();
      return this.modelSummary;
    }
    try {
      const client = this.plugin.getClientFactory()();
      if (!client || client.getStatus() !== "running") {
        this.modelSummary = offlineModelSummary();
      } else {
        const status = await client.request("models.status", {});
        this.modelSummary = summarizeModelStatus(status);
      }
    } catch {
      this.modelSummary = offlineModelSummary();
    }
    return this.modelSummary;
  }
  /** Stream the core's model status into the models step. */
  async fillModelStatus(slot) {
    const s = await this.resolveModelSummary();
    if (!slot.isConnected) return;
    slot.empty();
    const box = slot.createDiv({
      cls: `sovereign-wizard-status ${s.provider === "unknown" ? "is-warn" : "is-ok"}`
    });
    box.createSpan({ text: s.message, cls: "sovereign-wizard-status-text" });
    if (s.total > 0) {
      const pct = Math.floor(s.embedded / s.total * 100);
      const meter = slot.createDiv({ cls: "sovereign-wizard-meter" });
      const fill = meter.createDiv({ cls: "sovereign-wizard-meter-fill" });
      fill.style.width = `${pct}%`;
      slot.createEl("p", {
        text: `${s.embedded} of ${s.total} chunks embedded (${pct}%)`,
        cls: "sovereign-wizard-subtitle"
      });
    }
  }
  /** Ollama auto-detect card for the models step. */
  async renderOllama(slot) {
    const card = slot.createDiv({ cls: "sovereign-wizard-status" });
    const text = card.createSpan({ cls: "sovereign-wizard-status-text" });
    text.setText("Checking for a local Ollama server\u2026");
    const { probeOllama: probeOllama2 } = await Promise.resolve().then(() => (init_ollama(), ollama_exports));
    const probe = await probeOllama2(
      this.plugin.settings.ollamaBaseUrl || void 0
    );
    if (!card.isConnected) return;
    if (!probe.found) {
      card.addClass("is-idle");
      text.setText(
        `No local Ollama at ${probe.baseUrl} \u2014 that is fine. Install it from ollama.com and start it; the plugin links it automatically once it runs.`
      );
      return;
    }
    card.addClass("is-ok");
    const names = probe.models.map((m) => m.name);
    text.setText(
      `Ollama is running at ${probe.baseUrl} with ${names.length} model(s): ` + (names.slice(0, 3).join(", ") + (names.length > 3 ? "\u2026" : "") || "none yet")
    );
    const row = slot.createDiv({ cls: "sovereign-wizard-actions" });
    const linkBtn = row.createEl("button", {
      text: "Link Ollama to the brain",
      cls: "mod-cta sovereign-btn-primary"
    });
    linkBtn.addEventListener("click", async () => {
      linkBtn.disabled = true;
      text.setText("Linking\u2026");
      const message = await this.plugin.linkOllamaNow();
      if (!card.isConnected) return;
      text.setText(message);
      new import_obsidian2.Notice(message, 8e3);
      this.modelSummary = null;
    });
  }
  async renderSync() {
    this.addTitle(
      "Vault sync",
      "The plugin reads your notes and sends them to the local core for indexing. This happens automatically in the background; run it now to see it work."
    );
    const statusEl = this.bodyEl.createDiv({ cls: "sovereign-wizard-status is-idle" });
    const statusText = statusEl.createSpan({ cls: "sovereign-wizard-status-text" });
    if (this.syncDone) {
      statusEl.removeClass("is-idle");
      statusEl.addClass("is-ok");
      statusText.setText("\u2713 Initial sync complete. The brain is indexed.");
    } else if (!this.syncing) {
      statusText.setText("Ready when you are.");
    } else {
      statusText.setText("Syncing\u2026 large vaults take a moment.");
    }
    if (!this.syncDone && !this.syncing) {
      const actions = this.bodyEl.createDiv({ cls: "sovereign-wizard-actions" });
      const run = actions.createEl("button", {
        text: "Sync now",
        cls: "mod-cta sovereign-btn-primary"
      });
      run.addEventListener("click", async () => {
        this.syncing = true;
        this.render();
        try {
          await this.plugin.syncNow();
          this.syncDone = true;
          new import_obsidian2.Notice("Initial vault sync complete.");
        } catch (err) {
          new import_obsidian2.Notice(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          this.syncing = false;
          this.render();
        }
      });
    }
    this.addNav("Next", () => {
      this.step = 5;
      this.render();
    });
  }
  renderDone() {
    this.addTitle(
      "You're set.",
      "Open the brain anytime with the hotkey (default Ctrl/Cmd+Shift+B), or from the brain icon in the left ribbon. The knowledge graph lives in the left sidebar \u2014 click the fork icon."
    );
    const list = this.bodyEl.createDiv({ cls: "sovereign-wizard-list" });
    for (const [k, v] of [
      ["Ask the brain", "Hotkey \u2192 overlay \u2192 type your question."],
      ["Review memories", "Facts appear as candidates; accept or reject them."],
      ["Everything local", "No cloud. No accounts. No telemetry. Ever."]
    ]) {
      const row = list.createDiv({ cls: "sovereign-wizard-list-row" });
      row.createSpan({ text: k, cls: "sovereign-wizard-list-key" });
      row.createSpan({ text: v, cls: "sovereign-wizard-list-val" });
    }
    this.addNav("Finish", () => void this.finish(), { back: true });
  }
  /** Mark setup complete and close. */
  async finish() {
    this.plugin.settings.onboardingComplete = true;
    await this.plugin.saveSettings();
    this.close();
  }
};

// src/settings/SettingTab.ts
var SovereignBrainSettingTab = class extends import_obsidian3.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  /**
   * Honest core diagnostics: the process status, the binary actually in use,
   * and — when the core is not running — the exact search space plus a restart
   * action. This is the surface that answers "why does it say the core is not
   * running?" without guesswork.
   */
  renderCoreStatus(containerEl) {
    const card = containerEl.createDiv({ cls: "sovereign-card" });
    const header = card.createDiv({ cls: "sovereign-card-header" });
    header.createSpan({ text: "CORE STATUS", cls: "sovereign-card-title" });
    const status = this.plugin.coreStatus();
    header.createSpan({
      text: status.toUpperCase(),
      cls: `sovereign-badge ${status === "running" ? "sovereign-badge-ok" : "sovereign-badge-risk-medium"}`
    });
    const list = card.createDiv({ cls: "sovereign-privacy-list" });
    const row = (key, value, warn = false) => {
      const r = list.createDiv({ cls: "sovereign-privacy-row" });
      r.createSpan({ text: key, cls: "sovereign-privacy-key" });
      const v = r.createSpan({ text: value, cls: "sovereign-privacy-val" });
      if (warn) v.addClass("sovereign-text-warning");
    };
    const resolution = this.plugin.resolveCore();
    row("Binary", resolution.path ?? "not found", !resolution.path);
    row("Plugin folder", this.plugin.pluginDirPath());
    const vault = this.plugin.vaultRoot();
    if (vault) row("Vault root", vault);
    if (!resolution.path) {
      card.createEl("p", {
        text: "Searched: " + resolution.searched.slice(0, 4).join("  \xB7  ") + (resolution.searched.length > 4 ? "  \u2026" : ""),
        cls: "sovereign-text-muted sovereign-text-xs"
      });
    }
    new import_obsidian3.Setting(card).setName("Restart core").setDesc("Start the local core process again after fixing the path or killing it.").addButton(
      (btn) => btn.setButtonText("Restart").onClick(async () => {
        btn.setDisabled(true);
        await this.plugin.restartCore();
        btn.setDisabled(false);
        this.display();
      })
    );
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Sovereign Second Brain Settings" });
    const privCard = containerEl.createDiv({ cls: "sovereign-card sovereign-privacy-card" });
    const pHeader = privCard.createDiv({ cls: "sovereign-card-header" });
    pHeader.createSpan({ text: "\u{1F6E1}\uFE0F ZERO-CLOUD PRIVACY ENFORCEMENT", cls: "sovereign-card-title" });
    pHeader.createSpan({ text: "ACTIVE", cls: "sovereign-badge sovereign-badge-ok" });
    const pList = privCard.createDiv({ cls: "sovereign-privacy-list" });
    const guarantees = [
      ["Network Access", "OFF (No sockets opened)"],
      ["Cloud APIs", "NONE"],
      ["Telemetry", "NONE"],
      ["Remote Processing", "NONE"],
      ["Local Processing", "ENABLED (100% on-device)"]
    ];
    for (const [k, v] of guarantees) {
      const row = pList.createDiv({ cls: "sovereign-privacy-row" });
      row.createSpan({ text: k, cls: "sovereign-privacy-key" });
      row.createSpan({ text: v, cls: "sovereign-privacy-val sovereign-text-success" });
    }
    containerEl.createEl("h3", { text: "Setup" });
    new import_obsidian3.Setting(containerEl).setName("Run setup wizard again").setDesc(
      this.plugin.settings.onboardingComplete ? "Walk through the first-run setup once more." : "Setup has not been completed yet."
    ).addButton(
      (btn) => btn.setButtonText("Open setup").onClick(() => {
        new SetupWizardModal(this.app, this.plugin).open();
      })
    );
    containerEl.createEl("h3", { text: "Core Daemon & Storage" });
    new import_obsidian3.Setting(containerEl).setName("Core binary path").setDesc("Absolute path to the sovereign-core binary (leave blank to auto-detect).").addText(
      (text) => text.setPlaceholder("Auto-detect").setValue(this.plugin.settings.coreBinaryPath).onChange(async (value) => {
        this.plugin.settings.coreBinaryPath = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Data directory").setDesc("Root directory where the core maintains local vector and SQLite state.").addText(
      (text) => text.setPlaceholder("~/SovereignBrain").setValue(this.plugin.settings.dataDir).onChange(async (value) => {
        this.plugin.settings.dataDir = value.trim();
        await this.plugin.saveSettings();
      })
    );
    this.renderCoreStatus(containerEl);
    containerEl.createEl("h3", { text: "Interface" });
    new import_obsidian3.Setting(containerEl).setName("Auto-link local Ollama").setDesc(
      "Detect a running Ollama server (default port 11434) and configure it as the embedding provider automatically, re-probing every few minutes."
    ).addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.ollamaAutoLink).onChange(async (value) => {
        this.plugin.settings.ollamaAutoLink = value;
        await this.plugin.saveSettings();
        if (value) this.plugin.restartOllamaWatcher();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Ollama server URL").setDesc("Empty uses OLLAMA_HOST or http://127.0.0.1:11434.").addText(
      (text) => text.setPlaceholder("http://127.0.0.1:11434").setValue(this.plugin.settings.ollamaBaseUrl).onChange(async (value) => {
        this.plugin.settings.ollamaBaseUrl = value.trim();
        await this.plugin.saveSettings();
      })
    ).addButton(
      (btn) => btn.setButtonText("Link now").onClick(async () => {
        const message = await this.plugin.linkOllamaNow();
        const { Notice: Notice3 } = await import("obsidian");
        new Notice3(message, 8e3);
        this.display();
      })
    );
    containerEl.createEl("h3", { text: "Brain overlay" });
    new import_obsidian3.Setting(containerEl).setName("Beam size").setDesc("Shape of the BorderBeam that rides the popup perimeter.").addDropdown((dropdown) => {
      for (const size of BEAM_SIZES) {
        dropdown.addOption(size, BEAM_SIZE_LABELS[size]);
      }
      dropdown.setValue(this.plugin.settings.beamSize).onChange(async (value) => {
        this.plugin.settings.beamSize = value;
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian3.Setting(containerEl).setName("Beam colour").setDesc("Theme accent adapts to the active Obsidian theme; presets are fixed palettes.").addDropdown((dropdown) => {
      for (const color of BEAM_COLORS) {
        dropdown.addOption(color, BEAM_COLOR_LABELS[color]);
      }
      dropdown.setValue(this.plugin.settings.beamColor).onChange(async (value) => {
        this.plugin.settings.beamColor = value;
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian3.Setting(containerEl).setName("Beam intensity").setDesc("0 keeps the beam almost invisible; 1 is as bright as it gets.").addSlider(
      (slider) => slider.setLimits(0, 100, 5).setValue(Math.round(this.plugin.settings.beamStrength * 100)).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.beamStrength = value / 100;
        await this.plugin.saveSettings();
      })
    );
    containerEl.createEl("h3", { text: "Local Inference Models" });
    const modelsCard = containerEl.createDiv({ cls: "sovereign-card" });
    const modelHeader = modelsCard.createDiv({ cls: "sovereign-card-header" });
    modelHeader.createSpan({ text: "MODEL STATUS", cls: "sovereign-card-title" });
    const daemon = this.plugin.getDaemon();
    if (!daemon || daemon.getStatus() !== "running") {
      modelsCard.createEl("p", {
        text: "The core is not running. Model status will appear once it starts.",
        cls: "sovereign-text-muted sovereign-text-xs"
      });
    } else {
      void (async () => {
        try {
          const client = this.plugin.getClientFactory()();
          if (!client) throw new Error("core not running");
          const status = await client.request("models.status", {});
          const rows = [
            ["Provider", status.provider],
            [
              "Embedding model",
              status.model_path ?? "built-in deterministic hash embedder"
            ],
            ["Model binary", status.binary_path ?? "in-process (none required)"],
            ["Vector dimension", String(status.dimension)],
            [
              "Embedded chunks",
              `${status.chunks_embedded} / ${status.chunks_total}` + (status.chunks_pending > 0 ? ` (${status.chunks_pending} pending)` : ""),
              status.chunks_pending > 0
            ]
          ];
          if (status.validation_error) {
            rows.push(["Validation error", status.validation_error, true]);
          }
          const list = modelsCard.createDiv({ cls: "sovereign-privacy-list" });
          for (const [k, v, warn] of rows) {
            const row = list.createDiv({ cls: "sovereign-privacy-row" });
            row.createSpan({ text: k, cls: "sovereign-privacy-key" });
            const val = row.createSpan({ text: v, cls: "sovereign-privacy-val" });
            if (warn) val.addClass("sovereign-text-warning");
          }
          const { probeOllama: probeOllama2 } = await Promise.resolve().then(() => (init_ollama(), ollama_exports));
          const ollama = await probeOllama2(
            this.plugin.settings.ollamaBaseUrl || void 0
          );
          const ollamaRow = list.createDiv({ cls: "sovereign-privacy-row" });
          ollamaRow.createSpan({ text: "Local Ollama", cls: "sovereign-privacy-key" });
          ollamaRow.createSpan({
            text: ollama.found ? `running at ${ollama.baseUrl} (${ollama.models.length} model(s))` : `not detected at ${ollama.baseUrl}`,
            cls: `sovereign-privacy-val ${ollama.found ? "sovereign-text-success" : ""}`
          });
          modelsCard.createEl("p", {
            text: "Models are never downloaded. Provide local GGUF files to the core to upgrade beyond the built-in embedder.",
            cls: "sovereign-text-muted sovereign-text-xs sovereign-privacy-footnote"
          });
        } catch (err) {
          modelsCard.createEl("p", {
            text: `Model status unavailable: ${err instanceof Error ? err.message : String(err)}`,
            cls: "sovereign-text-muted sovereign-text-xs"
          });
        }
      })();
    }
  }
};

// src/views/SovereignOverlayModal.ts
var import_obsidian4 = require("obsidian");

// src/components/AskViewComponent.ts
var ASK_ERROR_MESSAGE = "Unable to answer right now. Your notes were not modified.";
var PLACEHOLDER_IDLE = "What would you like to know?";
var PLACEHOLDER_AGAIN = "Ask another question\u2026";
var EVIDENCE_ANSWER_PREFIX = "Here is what your vault contains about this:";
function renderAnswerParagraph(parent, text) {
  const pattern = /\[([^\]\n]+)\]/g;
  let last = 0;
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    const inner = (m[1] ?? "").trim();
    const looksLikeCitation = /\.md$/i.test(inner) || /^\[\[/.test(m[0]) || inner.includes("/");
    if (!looksLikeCitation) continue;
    if (m.index > last) {
      parent.createSpan({ text: text.slice(last, m.index) });
    }
    const label = (inner.split("/").pop() ?? inner).replace(/\.md$/i, "");
    parent.createSpan({ text: label, cls: "sovereign-cite-ref" });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    parent.createSpan({ text: text.slice(last) });
  }
}
var AskViewComponent = class {
  constructor(parentEl, app, brain, options = {}) {
    this.app = app;
    this.brain = brain;
    this.options = options;
    this.queryInFlight = false;
    this.lastQuery = null;
    this.hasAnswered = false;
    this.containerEl = parentEl.createDiv({ cls: "sovereign-ask-view" });
    this.buildInputArea();
    this.resultContainerEl = this.containerEl.createDiv({
      cls: "sovereign-ask-results",
      attr: { "aria-live": "polite", "aria-busy": "false" }
    });
  }
  buildInputArea() {
    if (this.options.context) {
      const ctx = this.options.context;
      const row = this.containerEl.createDiv({ cls: "sovereign-ask-context" });
      row.createSpan({ text: "Current note", cls: "sovereign-ask-context-key" });
      row.createSpan({ text: ctx.label, cls: "sovereign-ask-context-value" });
      if (ctx.selectedText) {
        const selected = row.createDiv({ cls: "sovereign-ask-context-sel" });
        selected.createSpan({ text: "Selected", cls: "sovereign-ask-context-key" });
        selected.createSpan({
          text: `\u201C${this.snippet(ctx.selectedText)}\u201D`,
          cls: "sovereign-ask-context-value"
        });
      }
    }
    const inputWrapper = this.containerEl.createDiv({ cls: "sovereign-ask-input-box" });
    this.inputEl = inputWrapper.createEl("textarea", {
      cls: "sovereign-textarea sovereign-ask-textarea",
      attr: {
        placeholder: PLACEHOLDER_IDLE,
        rows: "1",
        "aria-label": "Ask your second brain",
        spellcheck: "false"
      }
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submitFromInput();
      }
    });
    this.inputEl.addEventListener("input", () => this.autoGrow());
    const actionsRow = inputWrapper.createDiv({ cls: "sovereign-ask-actions" });
    actionsRow.createSpan({
      text: "Enter to ask \xB7 Shift+Enter for a new line",
      cls: "sovereign-ask-hint"
    });
    this.submitBtn = actionsRow.createEl("button", {
      text: "Ask",
      cls: "sovereign-btn-primary sovereign-ask-submit",
      attr: { "aria-label": "Ask" }
    });
    this.submitBtn.addEventListener("click", () => this.submitFromInput());
  }
  autoGrow() {
    const el = this.inputEl;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }
  submitFromInput() {
    if (this.queryInFlight) return;
    const q = this.inputEl.value.trim();
    if (q) {
      void this.ask(q);
      return;
    }
    const contextual = this.contextQuery();
    if (contextual) void this.ask(contextual);
  }
  /** The text an empty-input question would use, when context exists. */
  contextQuery() {
    const ctx = this.options.context;
    if (!ctx) return null;
    const selected = ctx.selectedText?.trim();
    if (selected && selected.length > 0) return selected;
    const label = ctx.label.trim();
    return label.length > 0 ? label : null;
  }
  /** Truncate long excerpts/selections for chip display. */
  snippet(text, max = 60) {
    const collapsed = text.replace(/\s+/g, " ").trim();
    return collapsed.length > max ? `${collapsed.slice(0, max - 1)}\u2026` : collapsed;
  }
  /** Place keyboard focus in the ask input without disturbing its content. */
  focusInput() {
    this.inputEl.focus();
    const end = this.inputEl.value.length;
    this.inputEl.setSelectionRange(end, end);
  }
  /** Programmatic ask: fills the input and immediately queries. */
  setQuery(query) {
    this.inputEl.value = query;
    this.autoGrow();
    if (!this.queryInFlight) void this.ask(query);
  }
  /** The last query asked, for hosts that echo it (e.g. a status line). */
  get currentQuery() {
    return this.lastQuery;
  }
  setState(state) {
    this.options.onStateChange?.(state);
  }
  async ask(query) {
    this.queryInFlight = true;
    this.lastQuery = query;
    this.submitBtn.disabled = true;
    this.resultContainerEl.setAttribute("aria-busy", "true");
    if (this.hasAnswered) {
      this.inputEl.placeholder = PLACEHOLDER_AGAIN;
    }
    this.setState("thinking");
    this.resultContainerEl.empty();
    const flow = this.resultContainerEl.createDiv({ cls: "sovereign-ask-flow" });
    flow.createDiv({
      cls: "sovereign-ask-question",
      text: query
    });
    const thinking = flow.createDiv({ cls: "sovereign-ask-thinking" });
    thinking.createSpan({ text: "Thinking", cls: "sovereign-ask-thinking-text" });
    thinking.createSpan({ cls: "sovereign-ask-thinking-dots", attr: { "aria-hidden": "true" } });
    try {
      const result = await this.brain.queryBrain(query);
      if (!this.resultContainerEl.isConnected) return;
      this.renderResult(flow, result);
      this.hasAnswered = true;
      this.setState("answered");
    } catch (err) {
      console.error("[sovereign] ask failed:", err);
      if (!this.resultContainerEl.isConnected) return;
      this.renderError(flow);
      this.setState("error");
      this.options.onError?.(ASK_ERROR_MESSAGE);
    } finally {
      this.queryInFlight = false;
      this.submitBtn.disabled = false;
      this.resultContainerEl.setAttribute("aria-busy", "false");
    }
  }
  renderError(flow) {
    flow.querySelector(".sovereign-ask-thinking")?.remove();
    const box = flow.createDiv({ cls: "sovereign-ask-error" });
    box.createSpan({ text: "Unable to answer right now." });
    box.createSpan({ text: "Your notes were not modified.", cls: "sovereign-ask-error-sub" });
  }
  renderResult(flow, result) {
    flow.querySelector(".sovereign-ask-thinking")?.remove();
    const answerCard = flow.createDiv({ cls: "sovereign-answer-card" });
    answerCard.createDiv({
      cls: "sovereign-answer-topic",
      text: this.topicOf(result.query ?? this.currentQuery ?? "")
    });
    const answerBody = answerCard.createDiv({ cls: "sovereign-answer-body" });
    this.renderAnswer(answerBody, result);
    if (result.sources.length > 0 || result.confidence !== "low") {
      answerCard.createDiv({
        cls: `sovereign-conf-line sovereign-conf-${result.confidence}`,
        text: result.confidence === "high" ? "Strong grounding in your notes" : result.confidence === "medium" ? "Grounded in your notes" : "Weak grounding \u2014 verify in sources"
      });
    }
    if (result.conflicts && result.conflicts.length > 0) {
      for (const conflict of result.conflicts) {
        const conflictBox = answerCard.createDiv({
          cls: "sovereign-alert-box sovereign-alert-warning"
        });
        conflictBox.createDiv({
          cls: "sovereign-alert-title",
          text: "\u26A0\uFE0F Potential contradiction"
        });
        const cGrid = conflictBox.createDiv({ cls: "sovereign-alert-grid" });
        const col1 = cGrid.createDiv({ cls: "sovereign-alert-col" });
        col1.createSpan({ text: "Earlier:", cls: "sovereign-text-muted sovereign-text-xs" });
        col1.createEl("blockquote", { text: `"${conflict.earlier}"` });
        col1.createSpan({
          text: this.sourceTitle(conflict.earlier_source),
          cls: "sovereign-source-path"
        });
        const col2 = cGrid.createDiv({ cls: "sovereign-alert-col" });
        col2.createSpan({ text: "Later:", cls: "sovereign-text-muted sovereign-text-xs" });
        col2.createEl("blockquote", { text: `"${conflict.later}"` });
        col2.createSpan({
          text: this.sourceTitle(conflict.later_source),
          cls: "sovereign-source-path"
        });
        conflictBox.createDiv({
          cls: "sovereign-alert-interp sovereign-text-sm",
          text: `Note: ${conflict.interpretation}`
        });
      }
    }
    if (result.sources.length > 0) {
      const srcSection = answerCard.createDiv({ cls: "sovereign-sources-section" });
      srcSection.createDiv({
        cls: "sovereign-section-subhead",
        text: `Sources \xB7 ${result.sources.length}`
      });
      const srcList = srcSection.createDiv({ cls: "sovereign-sources-list" });
      result.sources.forEach((src, i) => {
        srcList.appendChild(this.buildSourceItem(src, i === 0));
      });
    }
    if (result.memories.length > 0) {
      const memSection = answerCard.createDiv({ cls: "sovereign-memories-drawer" });
      memSection.createDiv({
        cls: "sovereign-section-subhead",
        text: `Related memory \xB7 ${result.memories.length}`
      });
      for (const mem of result.memories) {
        const memItem = memSection.createDiv({ cls: "sovereign-memory-chip" });
        memItem.createSpan({
          text: mem.statement,
          cls: "sovereign-memory-statement"
        });
        memItem.createSpan({
          text: mem.type,
          cls: `sovereign-badge sovereign-badge-${mem.type}`
        });
      }
    }
    this.renderRelated(answerCard, result);
  }
  /**
   * The answer body: one paragraph per line of the core's answer. The
   * deterministic evidence fallback (a bullet list of raw snippets) is
   * presented as the compact "notes that mention this" list it actually is —
   * not as a fake prose answer.
   */
  renderAnswer(answerBody, result) {
    const raw = (result.answer ?? "").trim();
    if (!raw) return;
    const lines = raw.split(/\n+/).map((l) => l.replace(/^[-*]\s+/, "").trim()).filter((l) => l.length > 0);
    const isEvidenceDump = lines.length > 1 && raw.includes(EVIDENCE_ANSWER_PREFIX);
    if (isEvidenceDump) {
      answerBody.createEl("p", {
        text: "Your notes mention this in several places:",
        cls: "sovereign-answer-lede"
      });
      for (const line of lines.filter((l) => !l.startsWith(EVIDENCE_ANSWER_PREFIX))) {
        const p = answerBody.createEl("p", { cls: "sovereign-answer-evidence" });
        renderAnswerParagraph(p, line);
      }
      return;
    }
    for (const line of lines) {
      const p = answerBody.createEl("p");
      renderAnswerParagraph(p, line);
    }
  }
  /** "What do I know about motor anomaly detection?" → "Motor anomaly detection". */
  topicOf(query) {
    let q = query.trim().replace(/[?!.]+$/, "");
    const m = q.match(/^(?:what (?:do|is|are)|who) (?:i|we|my|the)?\s*(?:know|need to know)?\s*(?:about|regarding|on)\s+(.+)$/i) ?? q.match(/^(?:tell me )?about\s+(.+)$/i) ?? q.match(/^(?:how|why|when|where)\s+(?:do|does|did|to)\s+(?:i|we|my)?\s*(.+)$/i);
    q = (m?.[1] ?? q).trim();
    return q.charAt(0).toUpperCase() + q.slice(1);
  }
  renderRelated(answerCard, result) {
    const provider = this.options.related;
    if (!provider || result.sources.length === 0) return;
    const cited = new Set(result.sources.map((s) => s.path));
    const related = provider(result.sources.map((s) => s.path)).filter(
      (note) => !cited.has(note.path)
    );
    if (related.length === 0) return;
    const section = answerCard.createDiv({ cls: "sovereign-related-section" });
    section.createDiv({ cls: "sovereign-section-subhead", text: "RELATED" });
    const list = section.createDiv({ cls: "sovereign-related-list" });
    for (const note of related) {
      const link = list.createEl("a", {
        text: note.title,
        cls: "sovereign-related-link",
        attr: { href: "#" }
      });
      link.addEventListener("click", (e) => {
        e.preventDefault();
        void this.app.workspace.openLinkText(note.path, "", false);
      });
    }
  }
  /** "folder/Note Name.md" → "Note Name" for display. */
  sourceTitle(path4) {
    const base = path4.split("/").pop() ?? path4;
    return base.replace(/\.md$/i, "");
  }
  /**
   * One collapsible source row. The title always opens the real note; the
   * caret toggles the excerpt.
   */
  buildSourceItem(src, expanded) {
    const item = createDiv({ cls: "sovereign-source-item" });
    if (expanded) item.addClass("is-open");
    const head = item.createDiv({ cls: "sovereign-source-head" });
    const link = head.createEl("a", {
      text: this.sourceTitle(src.path),
      cls: "sovereign-source-link"
    });
    link.addEventListener("click", (e) => {
      e.preventDefault();
      void this.app.workspace.openLinkText(src.path, "", false);
    });
    if (src.score !== void 0) {
      head.createSpan({
        text: `${Math.round(src.score * 100)}%`,
        cls: "sovereign-source-score"
      });
    }
    head.createSpan({
      cls: "sovereign-source-caret",
      attr: { "aria-hidden": "true" }
    });
    const excerpt = item.createDiv({ cls: "sovereign-source-excerpt" });
    const excerptInner = excerpt.createDiv({ cls: "sovereign-source-excerpt-inner" });
    excerptInner.createEl("p", { text: src.excerpt });
    const openLink = excerptInner.createEl("a", {
      text: "Open note \u2192",
      cls: "sovereign-source-open",
      attr: { href: "#" }
    });
    openLink.addEventListener("click", (e) => {
      e.preventDefault();
      void this.app.workspace.openLinkText(src.path, "", false);
    });
    const toggle = () => {
      const open = !item.hasClass("is-open");
      item.toggleClass("is-open", open);
      item.setAttribute("aria-expanded", open ? "true" : "false");
    };
    item.setAttribute("aria-expanded", expanded ? "true" : "false");
    head.addEventListener("click", (e) => {
      if (e.target !== link) toggle();
    });
    head.setAttribute("role", "button");
    head.setAttribute("tabindex", "0");
    head.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });
    return item;
  }
};

// src/components/BrainAskSurface.ts
var BrainAskSurface = class {
  constructor(parentEl, app, brain, options = {}) {
    this.options = options;
    const root = parentEl.createDiv({ cls: "sovereign-brain-surface" });
    this.heroEl = root.createDiv({ cls: "sovereign-brain-hero" });
    this.heroEl.createSpan({
      text: "\u2726",
      cls: "sovereign-brain-hero-mark",
      attr: { "aria-hidden": "true" }
    });
    this.heroEl.createSpan({ text: "Ask your second brain", cls: "sovereign-brain-hero-text" });
    this.ask = new AskViewComponent(root, app, brain, {
      onStateChange: (state) => this.onAskState(state),
      context: options.context,
      related: options.related
    });
  }
  onAskState(state) {
    this.heroEl.toggleClass("is-hidden", state !== "idle");
    this.options.onStateChange?.(state);
  }
  /** Open into a ready-to-type state. */
  focusInput() {
    this.ask.focusInput();
  }
  /** Pre-fill and immediately ask (graph → "Ask Sovereign" integration). */
  askQuestion(query) {
    this.ask.setQuery(query);
    this.focusInput();
  }
};

// src/views/SovereignOverlayModal.ts
var SovereignOverlayModal = class extends import_obsidian4.Modal {
  constructor(app, services, options = {}) {
    super(app);
    this.services = services;
    this.options = options;
    this.surface = null;
    this.frame = null;
    this.cssRef = null;
    this.beamOptions = { ...services.beam, ...options.beam };
  }
  async onOpen() {
    const { contentEl, modalEl } = this;
    contentEl.empty();
    modalEl.addClass("sovereign-overlay-modal");
    const frame = contentEl.createDiv({ cls: "sovereign-overlay-frame" });
    frame.createDiv({ cls: "sovereign-beam-layer" });
    this.frame = frame;
    applyBeam(frame, this.beamOptions);
    this.cssRef = this.app.workspace.on("css-change", () => {
      if (this.frame) applyBeam(this.frame, this.beamOptions);
    });
    const surfaceHost = frame.createDiv({ cls: "sovereign-overlay-body" });
    this.surface = new BrainAskSurface(surfaceHost, this.app, this.services.brain, {
      onStateChange: (state) => this.setFrameState(state),
      context: this.options.context,
      related: this.services.related
    });
    const closeBtn = frame.createDiv({ cls: "sovereign-overlay-close" });
    closeBtn.setText("\u2715");
    closeBtn.setAttribute("aria-label", "Close Sovereign Brain");
    closeBtn.setAttribute("role", "button");
    closeBtn.setAttribute("tabindex", "0");
    const close = () => this.close();
    closeBtn.addEventListener("click", close);
    closeBtn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        close();
      }
    });
    this.surface.focusInput();
    if (this.options.query) {
      this.surface.askQuestion(this.options.query);
    }
  }
  /** Beam phases mirror the ask lifecycle; errors stay restrained. */
  setFrameState(state) {
    if (!this.frame) return;
    this.frame.removeClass("is-thinking", "is-error", "is-answered");
    if (state === "thinking") this.frame.addClass("is-thinking");
    else if (state === "error") this.frame.addClass("is-error");
    else if (state === "answered") this.frame.addClass("is-answered");
  }
  onClose() {
    if (this.cssRef) {
      this.app.workspace.offref(this.cssRef);
      this.cssRef = null;
    }
    this.surface = null;
    this.frame = null;
    this.contentEl.empty();
    return Promise.resolve();
  }
};
function openSovereignOverlay(app, services, options = {}) {
  new SovereignOverlayModal(app, services, options).open();
}

// src/views/SovereignGraphView.ts
var import_obsidian5 = require("obsidian");

// src/components/graph/buildGraphModel.ts
function noteId(path4) {
  return `note:${path4}`;
}
function tagId(tag) {
  return `tag:${tag}`;
}
function noteLabel(path4) {
  const base = path4.split("/").pop() ?? path4;
  return base.replace(/\.md$/i, "");
}
function buildGraphModel(resolvedLinks, unresolvedLinks, tags = {}) {
  const nodes = /* @__PURE__ */ new Map();
  const edges = [];
  const seenEdge = /* @__PURE__ */ new Set();
  const addNote = (path4, unresolved = false) => {
    const id = noteId(path4);
    const existing = nodes.get(id);
    if (existing) {
      if (existing.unresolved && !unresolved) existing.unresolved = false;
      return id;
    }
    nodes.set(id, { id, kind: "note", label: noteLabel(path4), unresolved });
    return id;
  };
  const addEdge = (source, target, kind) => {
    const key = `${kind}\0${source}\0${target}`;
    if (source === target || seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push({ source, target, kind });
  };
  for (const from of Object.keys(resolvedLinks).sort()) {
    const fromId = addNote(from);
    for (const to of Object.keys(resolvedLinks[from] ?? {}).sort()) {
      const toId = addNote(to);
      addEdge(fromId, toId, "link");
    }
  }
  for (const from of Object.keys(unresolvedLinks).sort()) {
    const fromId = addNote(from);
    for (const to of Object.keys(unresolvedLinks[from] ?? {}).sort()) {
      const id = noteId(to);
      if (!nodes.has(id)) {
        nodes.set(id, { id, kind: "note", label: noteLabel(to), unresolved: true });
      }
      addEdge(fromId, id, "link");
    }
  }
  for (const path4 of Object.keys(tags).sort()) {
    const entries = tags[path4] ?? {};
    const fromId = addNote(path4);
    for (const rawTag of Object.keys(entries).sort()) {
      const tag = rawTag.replace(/^#/, "");
      if (!tag) continue;
      const id = tagId(tag);
      if (!nodes.has(id)) {
        nodes.set(id, { id, kind: "tag", label: tag, unresolved: false });
      }
      addEdge(fromId, id, "tag");
    }
  }
  return finalize(nodes, edges);
}
function finalize(nodes, edges) {
  const adjacency = /* @__PURE__ */ new Map();
  for (const node of nodes.keys()) adjacency.set(node, []);
  for (const edge of edges) {
    adjacency.get(edge.source)?.push(edge.target);
    adjacency.get(edge.target)?.push(edge.source);
  }
  return { nodes: [...nodes.values()], edges, adjacency };
}

// src/components/graph/forceLayout.ts
var REPULSION = 2400;
var SPRING_LENGTH = 90;
var SPRING_STRENGTH = 0.04;
var DAMPING = 0.85;
var ITERATIONS = 220;
var CANVAS_RADIUS = 420;
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function computeLayout(model, seed = 2654435769) {
  const rng = makeRng(seed ^ 2246822507);
  const nodes = model.nodes;
  const positions = /* @__PURE__ */ new Map();
  nodes.forEach((node, i) => {
    const angle = 2 * Math.PI * i / Math.max(1, nodes.length);
    const radius = node.kind === "tag" ? CANVAS_RADIUS * 0.35 : CANVAS_RADIUS * 0.7;
    positions.set(node.id, {
      x: Math.cos(angle) * radius + (rng() - 0.5) * 40,
      y: Math.sin(angle) * radius + (rng() - 0.5) * 40
    });
  });
  const velocities = /* @__PURE__ */ new Map();
  for (const node of nodes) velocities.set(node.id, { x: 0, y: 0 });
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const forces = /* @__PURE__ */ new Map();
    for (const node of nodes) forces.set(node.id, { x: 0, y: 0 });
    const cell = SPRING_LENGTH * 2;
    const grid = /* @__PURE__ */ new Map();
    for (const node of nodes) {
      const p = positions.get(node.id);
      const key = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(node);
      else grid.set(key, [node]);
    }
    for (const node of nodes) {
      const p = positions.get(node.id);
      const gx = Math.floor(p.x / cell);
      const gy = Math.floor(p.y / cell);
      const force = forces.get(node.id);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const bucket = grid.get(`${gx + dx},${gy + dy}`);
          if (!bucket) continue;
          for (const other of bucket) {
            if (other.id === node.id) continue;
            const q = positions.get(other.id);
            applyRepulsion(node, p, q, force);
          }
        }
      }
    }
    for (const edge of model.edges) {
      const a = positions.get(edge.source);
      const b = positions.get(edge.target);
      if (!a || !b) continue;
      const length = edge.kind === "tag" ? SPRING_LENGTH * 1.35 : SPRING_LENGTH;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1e-4;
      const displacement = SPRING_STRENGTH * (dist - length) * Math.min(3, 1 + dist / (length * 2));
      const fx = dx / dist * displacement;
      const fy = dy / dist * displacement;
      const fa = forces.get(edge.source);
      const fb = forces.get(edge.target);
      fa.x += fx;
      fa.y += fy;
      fb.x -= fx;
      fb.y -= fy;
    }
    const cooling = 1 - iter / ITERATIONS;
    for (const node of nodes) {
      const force = forces.get(node.id);
      const vel = velocities.get(node.id);
      vel.x = (vel.x + force.x * 0.02) * DAMPING;
      vel.y = (vel.y + force.y * 0.02) * DAMPING;
      const p = positions.get(node.id);
      p.x += vel.x * cooling;
      p.y += vel.y * cooling;
    }
  }
  let cx = 0;
  let cy = 0;
  for (const p of positions.values()) {
    cx += p.x;
    cy += p.y;
  }
  cx /= Math.max(1, positions.size);
  cy /= Math.max(1, positions.size);
  for (const p of positions.values()) {
    p.x -= cx;
    p.y -= cy;
  }
  return { positions };
}
function applyRepulsion(node, p, q, force) {
  let dx = p.x - q.x;
  let dy = p.y - q.y;
  let distSq = dx * dx + dy * dy;
  if (distSq < 0.01) {
    const nudge = hashString(node.id) % 7 - 3 || 1;
    dx = nudge * 0.37;
    dy = -nudge * 0.21;
    distSq = dx * dx + dy * dy;
  }
  const dist = Math.sqrt(distSq);
  const strength = REPULSION / (distSq * dist + 0.01);
  force.x += dx * strength * 0.01;
  force.y += dy * strength * 0.01;
}

// src/components/graph/clusters.ts
var MIN_REGION_SIZE = 3;
function findClusters(model) {
  const byId = /* @__PURE__ */ new Map();
  for (const node of model.nodes) byId.set(node.id, node);
  const parent = /* @__PURE__ */ new Map();
  const find = (id) => {
    let root = parent.get(id) ?? id;
    while (root !== (parent.get(root) ?? root)) root = parent.get(root) ?? root;
    let cur = id;
    while (cur !== root) {
      const next = parent.get(cur) ?? root;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };
  for (const id of byId.keys()) parent.set(id, id);
  for (const edge of model.edges) {
    if (byId.has(edge.source) && byId.has(edge.target)) union(edge.source, edge.target);
  }
  const groups = /* @__PURE__ */ new Map();
  for (const id of byId.keys()) {
    const root = find(id);
    const bucket = groups.get(root);
    if (bucket) bucket.push(id);
    else groups.set(root, [id]);
  }
  const clusters = [];
  for (const members of groups.values()) {
    members.sort();
    const label = labelFor(members, byId, model);
    clusters.push({
      id: members[0],
      nodeIds: members,
      size: members.length,
      label: label.label,
      labelSource: label.source,
      hubId: label.hubId,
      hubDegree: model.adjacency.get(label.hubId)?.length ?? 0
    });
  }
  clusters.sort((a, b) => b.size - a.size || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return clusters;
}
function clusterIndex(clusters) {
  const index = /* @__PURE__ */ new Map();
  for (const cluster of clusters) {
    for (const id of cluster.nodeIds) index.set(id, cluster.id);
  }
  return index;
}
function labelFor(members, byId, model) {
  let hubId = members[0];
  let hubDegree = model.adjacency.get(hubId)?.length ?? 0;
  for (const id of members) {
    const degree = model.adjacency.get(id)?.length ?? 0;
    if (degree > hubDegree || degree === hubDegree && id < hubId) {
      hubId = id;
      hubDegree = degree;
    }
  }
  const tagCounts = /* @__PURE__ */ new Map();
  for (const id of members) {
    const node = byId.get(id);
    if (!node || node.kind !== "tag") continue;
    if ((model.adjacency.get(id)?.length ?? 0) < 2) continue;
    tagCounts.set(node.label, (tagCounts.get(node.label) ?? 0) + 1);
  }
  let bestTag = null;
  let bestTagCount = 0;
  for (const [tag, count] of [...tagCounts.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    if (count > bestTagCount) {
      bestTag = tag;
      bestTagCount = count;
    }
  }
  if (bestTag && members.length >= MIN_REGION_SIZE) {
    return { label: `#${bestTag}`, source: "tag", hubId };
  }
  if (members.length >= MIN_REGION_SIZE) {
    const hub = byId.get(hubId);
    if (hub) return { label: hub.label, source: "hub", hubId };
  }
  return {
    label: `${members.length} note${members.length === 1 ? "" : "s"}`,
    source: "count",
    hubId
  };
}

// src/components/graph/renderGraph.ts
var CAMERA_ZOOM_MIN = 0.05;
var CAMERA_ZOOM_MAX = 6;
function nodeDegree(model, id) {
  return model.adjacency.get(id)?.length ?? 0;
}
function effectiveRadius(model, node) {
  const base = node.kind === "tag" ? 5 : 6.5;
  if (node.kind !== "note") return base;
  const degree = nodeDegree(model, node.id);
  const scale = 1 + Math.min(Math.sqrt(degree) * 0.36, 2.1);
  return base * scale;
}
function easeInOutCubic(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function emphasisFor(model, nodeId, state) {
  if (state.searchMatches) {
    if (state.searchMatches.has(nodeId)) return 1;
    return nodeId === state.selectedId ? 0.9 : 0.1;
  }
  if (state.selectedId) {
    if (nodeId === state.selectedId) return 1;
    for (const n of model.adjacency.get(state.selectedId) ?? []) {
      if (n === nodeId) return 1;
    }
    return 0.12;
  }
  return 1;
}
function edgeEmphasis(model, source, target, state) {
  const a = emphasisFor(model, source, state);
  const b = emphasisFor(model, target, state);
  return Math.min(a, b);
}
function fitCameraToPoints(points, viewport, opts = {}) {
  const padding = opts.padding ?? 80;
  const minZoom = opts.minZoom ?? CAMERA_ZOOM_MIN;
  const maxZoom = opts.maxZoom ?? 1.6;
  if (points.length === 0) return { x: 0, y: 0, zoom: 1 };
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const zoom = Math.min(
    maxZoom,
    Math.max(minZoom, Math.min(viewport.width / (bw + padding * 2), viewport.height / (bh + padding * 2)))
  );
  return {
    x: -(minX + maxX) / 2,
    y: -(minY + maxY) / 2,
    zoom
  };
}
function worldToScreen(p, camera, viewport) {
  return {
    x: viewport.width / 2 + (p.x + camera.x) * camera.zoom,
    y: viewport.height / 2 + (p.y + camera.y) * camera.zoom
  };
}
function screenToWorld(sx, sy, camera, viewport) {
  return {
    x: (sx - viewport.width / 2) / camera.zoom - camera.x,
    y: (sy - viewport.height / 2) / camera.zoom - camera.y
  };
}
function labelCharBudget(zoom, emphasized) {
  if (emphasized && zoom >= 0.35) return 44;
  if (zoom >= 1.1) return 44;
  if (zoom >= 0.7) return 28;
  if (zoom >= 0.45) return 18;
  return 0;
}
function shouldLabelNode(zoom, emphasized, degree) {
  if (emphasized) return zoom >= 0.3;
  if (zoom >= 1.15) return true;
  if (zoom >= 0.7) return degree >= 3;
  return false;
}
function shouldLabelRegion(zoom, size) {
  if (size < MIN_REGION_SIZE) return false;
  if (zoom >= 1.15) return false;
  if (zoom >= 0.5) return size >= 8;
  return true;
}
function renderGraph(input) {
  const { ctx, model, positions, camera, viewport, dpr, theme, state } = input;
  const w = viewport.width;
  const h = viewport.height;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const entrance = state.entranceProgress;
  if (input.clusters && input.clusters.length > 0 && camera.zoom < 1.15) {
    for (const cluster of input.clusters) {
      if (cluster.size < MIN_REGION_SIZE) continue;
      let cx = 0;
      let cy = 0;
      let seen = 0;
      for (const id of cluster.nodeIds) {
        const p = positions.get(id);
        if (!p) continue;
        cx += p.x;
        cy += p.y;
        seen++;
      }
      if (seen === 0) continue;
      cx /= seen;
      cy /= seen;
      let maxD = 0;
      for (const id of cluster.nodeIds) {
        const p = positions.get(id);
        if (!p) continue;
        maxD = Math.max(maxD, Math.hypot(p.x - cx, p.y - cy));
      }
      const emphasis = emphasisFor(model, cluster.hubId, state) * entrance;
      if (emphasis <= 0.05) continue;
      const center = worldToScreen({ x: cx, y: cy }, camera, viewport);
      const radius = Math.max(24, (maxD + 70) * camera.zoom);
      if (center.x < -radius || center.x > w + radius || center.y < -radius || center.y > h + radius) {
        continue;
      }
      const fade = 1 - Math.min(1, camera.zoom / 1.2);
      const alpha = 0.055 * emphasis * fade;
      if (alpha > 4e-3) {
        const gradient = ctx.createRadialGradient(
          center.x,
          center.y,
          radius * 0.15,
          center.x,
          center.y,
          radius
        );
        gradient.addColorStop(0, withAlpha(theme.accent, alpha));
        gradient.addColorStop(1, withAlpha(theme.accent, 0));
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
      if (shouldLabelRegion(camera.zoom, cluster.size)) {
        ctx.globalAlpha = 0.55 * emphasis * fade;
        ctx.fillStyle = theme.faint;
        ctx.font = `600 10px ${theme.font}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(cluster.label.toUpperCase(), center.x, center.y - radius * 0.55);
        ctx.globalAlpha = 1;
      }
    }
  }
  for (const edge of model.edges) {
    const a = positions.get(edge.source);
    const b = positions.get(edge.target);
    if (!a || !b) continue;
    const emphasis = edgeEmphasis(model, edge.source, edge.target, state) * entrance;
    if (emphasis <= 0.02) continue;
    const pa = worldToScreen(a, camera, viewport);
    const pb = worldToScreen(b, camera, viewport);
    if (pa.x < -40 && pb.x < -40 || pa.x > w + 40 && pb.x > w + 40 || pa.y < -40 && pb.y < -40 || pa.y > h + 40 && pb.y > h + 40) {
      continue;
    }
    const isTag = edge.kind === "tag";
    const isConnectedToSelection = state.selectedId !== null && (edge.source === state.selectedId || edge.target === state.selectedId);
    const lit = emphasis >= 0.99;
    ctx.globalAlpha = isTag ? emphasis * 0.32 : emphasis * (lit ? 0.55 : 0.4);
    ctx.strokeStyle = isConnectedToSelection && lit ? theme.accent : theme.faint;
    ctx.lineWidth = isTag ? 0.75 : isConnectedToSelection && lit ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }
  const drawOrder = [];
  for (const node of model.nodes) {
    const pos = positions.get(node.id);
    if (!pos) continue;
    const emphasis = emphasisFor(model, node.id, state);
    drawOrder.push({ node, pos, emphasis });
  }
  drawOrder.sort((x, y) => x.emphasis - y.emphasis);
  for (const { node, pos, emphasis } of drawOrder) {
    const s = worldToScreen(pos, camera, viewport);
    const rWorld = effectiveRadius(model, node);
    const isSelected = node.id === state.selectedId;
    const isHover = node.id === state.hoverId;
    const grow = isSelected ? 1.35 : isHover ? 1.15 : 1;
    const r = Math.max(1.5, rWorld * camera.zoom * grow * (0.5 + 0.5 * entrance));
    if (s.x < -60 || s.x > w + 60 || s.y < -60 || s.y > h + 60) continue;
    ctx.globalAlpha = emphasis * entrance;
    if (emphasis <= 0.02) continue;
    if (isSelected) {
      const halo = ctx.createRadialGradient(s.x, s.y, r * 0.4, s.x, s.y, r * 3.2);
      halo.addColorStop(0, withAlpha(theme.accent, 0.28));
      halo.addColorStop(1, withAlpha(theme.accent, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r * 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
    if (node.kind === "tag") {
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = theme.tagFill;
      ctx.strokeStyle = isSelected || isHover ? theme.accent : withAlpha(theme.text, 0.55);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(-r * 0.82, -r * 0.82, r * 1.64, r * 1.64);
      ctx.fill();
      if (isSelected || isHover) ctx.stroke();
      ctx.restore();
    } else if (node.unresolved) {
      ctx.save();
      ctx.strokeStyle = withAlpha(theme.warning, 0.8);
      ctx.lineWidth = 1.25;
      ctx.setLineDash([2.5, 2.5]);
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.fillStyle = isSelected ? theme.accent : withAlpha(theme.accent, 0.88);
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fill();
      if (isHover && !isSelected) {
        ctx.strokeStyle = theme.accentSoft;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 2.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    const emphasized = emphasis >= 0.99 || isSelected || isHover;
    const degree = nodeDegree(model, node.id);
    const budget = shouldLabelNode(camera.zoom, emphasized, degree) ? labelCharBudget(camera.zoom, emphasized) : 0;
    if (budget > 0) {
      const label = node.label;
      if (label.length > 0) {
        const fontSize = node.kind === "tag" ? 10 : 11.5;
        ctx.font = `${node.kind === "tag" ? "italic " : "500 "}${fontSize}px ${theme.font}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const shown = label.length > budget ? `${label.slice(0, Math.max(1, budget - 1))}\u2026` : label;
        const ly = s.y - r - fontSize * 0.85;
        ctx.globalAlpha = emphasis * entrance * (isSelected ? 0.95 : 0.82);
        ctx.fillStyle = isSelected ? theme.text : theme.muted;
        ctx.strokeStyle = withAlpha(theme.text, 0);
        ctx.fillText(shown, s.x, ly);
      }
    }
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}
function withAlpha(color, alpha) {
  const a = Math.max(0, Math.min(1, alpha));
  const hex = color.trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  if (short) {
    const r = parseInt(short[1] + short[1], 16);
    const g = parseInt(short[2] + short[2], 16);
    const b = parseInt(short[3] + short[3], 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (long) {
    return `rgba(${parseInt(long[1], 16)}, ${parseInt(long[2], 16)}, ${parseInt(long[3], 16)}, ${a})`;
  }
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(hex);
  if (rgb) {
    return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${a})`;
  }
  return hex;
}

// src/views/SovereignGraphView.ts
var VIEW_TYPE_SOVEREIGN_GRAPH = "sovereign-graph-view";
var TRANSITION_MS = 420;
var ENTRANCE_MS = 650;
var SovereignGraphView = class extends import_obsidian5.ItemView {
  constructor(leaf, pluginInstance) {
    super(leaf);
    this.pluginInstance = pluginInstance;
    this.model = null;
    /** Real connected groups (connected components over link/tag edges). */
    this.clusters = [];
    this.clusterOf = /* @__PURE__ */ new Map();
    this.layoutPositions = /* @__PURE__ */ new Map();
    /** Animated display positions (eased toward the layout / drag targets). */
    this.positions = /* @__PURE__ */ new Map();
    this.camera = { x: 0, y: 0, zoom: 1 };
    this.cameraTransition = null;
    this.nodeAnims = [];
    this.entranceStart = null;
    this.visual = {
      selectedId: null,
      hoverId: null,
      searchMatches: null,
      entranceProgress: 1
    };
    this.draggingNode = null;
    this.dragMoved = false;
    this.panning = false;
    this.lastPointer = null;
    this.pinchDist = null;
    this.rafHandle = null;
    this.disposed = false;
    /** Match list for search cycling (real labels only). */
    this.matchIds = [];
    this.matchCursor = 0;
    /** `prefers-reduced-motion` — transitions become instant when set. */
    this.motionQuery = null;
  }
  getViewType() {
    return VIEW_TYPE_SOVEREIGN_GRAPH;
  }
  getDisplayText() {
    return "Sovereign knowledge graph";
  }
  getIcon() {
    return "git-fork";
  }
  async onOpen() {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass("sovereign-graph-root");
    const header = root.createDiv({ cls: "sovereign-graph-header" });
    const brand = header.createDiv({ cls: "sovereign-graph-brand" });
    brand.createSpan({ text: "Knowledge map", cls: "sovereign-graph-title" });
    this.statsEl = brand.createSpan({ cls: "sovereign-graph-stats" });
    const controls = header.createDiv({ cls: "sovereign-graph-controls" });
    this.searchCountEl = controls.createSpan({ cls: "sovereign-graph-search-count" });
    this.searchEl = controls.createEl("input", {
      cls: "sovereign-graph-search",
      attr: {
        type: "text",
        placeholder: "Search knowledge\u2026",
        spellcheck: "false",
        "aria-label": "Search the graph"
      }
    });
    this.searchEl.addEventListener("input", () => this.onSearchInput());
    this.searchEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.focusNextMatch();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.clearSearch();
        this.searchEl.blur();
      }
    });
    const fitBtn = controls.createEl("button", {
      cls: "sovereign-graph-icon-btn",
      attr: { "aria-label": "Fit graph to view" }
    });
    fitBtn.setText("\u2922");
    fitBtn.addEventListener("click", () => this.fitToContent(true));
    this.canvasBody = root.createDiv({ cls: "sovereign-graph-body" });
    this.canvas = this.canvasBody.createEl("canvas", { cls: "sovereign-graph-canvas" });
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("role", "application");
    this.canvas.setAttribute(
      "aria-label",
      "Sovereign knowledge graph. Arrow keys move between notes, Enter opens the selected note, F fits the map, Escape clears the selection."
    );
    this.srStatusEl = this.canvasBody.createDiv({
      cls: "sovereign-graph-sr",
      attr: { "aria-live": "polite" }
    });
    this.attachCanvasEvents();
    this.attachKeyboardEvents();
    this.motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.detailsEl = root.createDiv({
      cls: "sovereign-graph-details",
      attr: { "aria-live": "polite" }
    });
    this.detailsEl.hide();
    this.emptyEl = root.createDiv({ cls: "sovereign-graph-empty" });
    this.emptyEl.createDiv({ text: "YOUR KNOWLEDGE MAP", cls: "sovereign-graph-empty-title" });
    this.emptyEl.createDiv({
      text: "Your graph will grow as Sovereign indexes notes and relationships. Create a few linked notes to see the map take shape.",
      cls: "sovereign-graph-empty-sub"
    });
    const createBtn = this.emptyEl.createEl("button", {
      text: "Create a note",
      cls: "sovereign-graph-empty-btn"
    });
    createBtn.addEventListener("click", () => {
      void this.app.workspace.openLinkText("Untitled", "", true);
    });
    this.emptyEl.hide();
    this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
    this.resizeObserver.observe(this.canvasBody);
    this.resizeCanvas();
    this.rebuild();
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.rebuild()));
    this.registerEvent(
      this.app.metadataCache.on("changed", () => {
        this.renderStats();
        this.requestRender();
      })
    );
  }
  async onClose() {
    this.disposed = true;
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
    this.resizeObserver?.disconnect();
  }
  // ---- model --------------------------------------------------------------
  rebuild() {
    const cache = this.app.metadataCache;
    const resolved = cache.resolvedLinks ?? {};
    const unresolved = cache.unresolvedLinks ?? {};
    const tags = {};
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fileTags = /* @__PURE__ */ new Set();
      const fileCache = this.app.metadataCache.getFileCache(file);
      const fmTags = fileCache?.frontmatter?.tags;
      const bodyTags = fileCache?.tags ?? [];
      for (const t of Array.isArray(fmTags) ? fmTags : fmTags ? [fmTags] : []) {
        fileTags.add(String(t).replace(/^#/, ""));
      }
      for (const t of bodyTags) fileTags.add(t.tag.replace(/^#/, ""));
      if (fileTags.size > 0) {
        const entry = {};
        for (const t of fileTags) entry[`#${t}`] = 1;
        tags[file.path] = entry;
      }
    }
    this.model = buildGraphModel(resolved, unresolved, tags);
    this.layoutPositions = computeLayout(this.model, 2654435769).positions;
    this.clusters = findClusters(this.model);
    this.clusterOf = clusterIndex(this.clusters);
    const display = /* @__PURE__ */ new Map();
    for (const [id, p] of this.layoutPositions) {
      display.set(id, { ...p });
    }
    this.positions = display;
    this.cameraTransition = null;
    this.visual = { ...this.visual, selectedId: null, hoverId: null, searchMatches: null };
    this.detailsEl.hide();
    this.renderStats();
    const isEmpty = this.model.nodes.length === 0;
    this.emptyEl.toggle(isEmpty);
    this.canvasBody.toggleClass("is-empty", isEmpty);
    if (!isEmpty) {
      this.fitToContent(false);
      this.startEntrance();
    }
    this.requestRender();
  }
  renderStats() {
    if (!this.model) return;
    const notes = this.model.nodes.filter((n) => n.kind === "note" && !n.unresolved).length;
    const unresolved = this.model.nodes.filter((n) => n.kind === "note" && n.unresolved).length;
    const tags = this.model.nodes.filter((n) => n.kind === "tag").length;
    const parts = [`${notes} note${notes === 1 ? "" : "s"}`];
    if (tags > 0) parts.push(`${tags} tag${tags === 1 ? "" : "s"}`);
    if (unresolved > 0) parts.push(`${unresolved} unresolved`);
    this.statsEl.setText(parts.join(" \xB7 "));
  }
  // ---- theme --------------------------------------------------------------
  /** Resolve theme colors from Obsidian CSS variables (adapts to light/dark). */
  theme() {
    const styles = getComputedStyle(this.canvas);
    const pick = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
    return {
      accent: pick("--interactive-accent", "#7c6cff"),
      accentSoft: pick("--interactive-accent-hover", "#9a8cff"),
      text: pick("--text-normal", "#ddd"),
      muted: pick("--text-muted", "#999"),
      faint: pick("--text-faint", "#666"),
      border: pick("--background-modifier-border", "#333"),
      warning: pick("--text-warning", "#d97706"),
      tagFill: pick("--background-modifier-hover", "#2a2a2e"),
      font: pick("--font-interface", "sans-serif")
    };
  }
  // ---- canvas plumbing ------------------------------------------------------
  resizeCanvas() {
    if (!this.canvas) return;
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.requestRender();
  }
  viewport() {
    const dpr = window.devicePixelRatio || 1;
    return {
      width: this.canvas ? this.canvas.width / dpr : 0,
      height: this.canvas ? this.canvas.height / dpr : 0
    };
  }
  requestRender() {
    if (this.rafHandle !== null || this.disposed) return;
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = null;
      this.tick();
    });
  }
  /**
   * One animation tick: advance eased transitions, then draw. Schedules the
   * next frame ONLY while something is still animating — an idle graph never
   * repaints.
   */
  tick() {
    const now = performance.now();
    let animating = false;
    if (this.entranceStart !== null) {
      const t = Math.min(1, (now - this.entranceStart) / ENTRANCE_MS);
      this.visual.entranceProgress = easeInOutCubic(t);
      if (t < 1) animating = true;
      else this.entranceStart = null;
    } else {
      this.visual.entranceProgress = 1;
    }
    if (this.cameraTransition) {
      const { from, to, start } = this.cameraTransition;
      const t = Math.min(1, (now - start) / TRANSITION_MS);
      const e = easeInOutCubic(t);
      this.camera = {
        x: from.x + (to.x - from.x) * e,
        y: from.y + (to.y - from.y) * e,
        zoom: from.zoom + (to.zoom - from.zoom) * e
      };
      if (t < 1) animating = true;
      else this.cameraTransition = null;
    }
    if (this.nodeAnims.length > 0) {
      const still = [];
      for (const anim of this.nodeAnims) {
        const target = this.layoutPositions.get(anim.id);
        if (!target) continue;
        const t = Math.min(1, (now - anim.start) / TRANSITION_MS);
        const e = easeInOutCubic(t);
        const cur = this.positions.get(anim.id) ?? anim.from;
        this.positions.set(anim.id, {
          x: anim.from.x + (target.x - anim.from.x) * e,
          y: anim.from.y + (target.y - anim.from.y) * e
        });
        if (t < 1) still.push(anim);
        else ;
      }
      this.nodeAnims = still;
      if (still.length > 0) animating = true;
    }
    this.draw();
    if (animating) this.requestRender();
  }
  draw() {
    if (!this.model || !this.canvas) return;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    renderGraph({
      ctx,
      model: this.model,
      positions: this.positions,
      camera: this.camera,
      viewport: this.viewport(),
      dpr: window.devicePixelRatio || 1,
      theme: this.theme(),
      state: this.visual,
      clusters: this.clusters
    });
  }
  // ---- camera -------------------------------------------------------------
  /** Respect `prefers-reduced-motion`: transitions become instant, not absent. */
  reducedMotion() {
    return this.motionQuery?.matches ?? false;
  }
  /** Frame the whole graph. Animates when `animate` is set. */
  fitToContent(animate) {
    if (!this.model) return;
    const points = [...this.layoutPositions.values()];
    const target = fitCameraToPoints(points, this.viewport(), { minZoom: 0.2, maxZoom: 1.25 });
    this.animateCameraTo(target, animate);
  }
  /** Frame a real connected group — the "explore this region" gesture. */
  focusCluster(clusterId) {
    const cluster = this.clusters.find((c) => c.id === clusterId);
    if (!cluster) return;
    const points = cluster.nodeIds.map((nid) => this.positions.get(nid)).filter((p) => !!p);
    if (points.length === 0) return;
    this.animateCameraTo(
      fitCameraToPoints(points, this.viewport(), { minZoom: 0.25, maxZoom: 1.1, padding: 110 }),
      true
    );
    this.announce(`Focused group ${cluster.label} (${cluster.size} notes).`);
  }
  /** Fly the camera to a node and select it. */
  focusNode(id, select) {
    const pos = this.positions.get(id) ?? this.layoutPositions.get(id);
    if (!pos) return;
    const node = this.model?.nodes.find((n) => n.id === id);
    const r = node ? effectiveRadius(this.model, node) : 8;
    const zoom = Math.min(2.2, Math.max(0.9, 90 / Math.max(12, r)));
    const target = { x: -pos.x, y: -pos.y, zoom };
    this.animateCameraTo(target, true);
    if (select) this.select(id);
  }
  animateCameraTo(target, animate) {
    if (!animate || this.reducedMotion()) {
      this.camera = { ...target };
      this.cameraTransition = null;
      this.requestRender();
      return;
    }
    this.cameraTransition = {
      from: { ...this.camera },
      to: target,
      start: performance.now()
    };
    this.requestRender();
  }
  startEntrance() {
    if (this.reducedMotion()) {
      this.entranceStart = null;
      this.visual.entranceProgress = 1;
      this.requestRender();
      return;
    }
    this.entranceStart = performance.now();
    this.visual.entranceProgress = 0;
    this.requestRender();
  }
  // ---- selection / search ---------------------------------------------------
  select(id) {
    if (this.visual.selectedId === id) return;
    this.visual.selectedId = id;
    this.renderDetails();
    const node = id ? this.model?.nodes.find((n) => n.id === id) : null;
    if (node) {
      const connections = this.model?.adjacency.get(node.id)?.length ?? 0;
      this.announce(`Selected ${node.label}, ${connections} connections.`);
    } else {
      this.announce("Selection cleared.");
    }
    this.requestRender();
  }
  /** Announce state changes to assistive tech without visual chrome. */
  announce(message) {
    if (this.srStatusEl) this.srStatusEl.setText(message);
  }
  onSearchInput() {
    const q = this.searchEl.value.trim().toLowerCase();
    if (!q) {
      this.visual.searchMatches = null;
      this.matchIds = [];
      this.matchCursor = 0;
      this.searchCountEl.setText("");
      this.requestRender();
      return;
    }
    if (!this.model) return;
    this.matchIds = this.model.nodes.filter((n) => n.label.toLowerCase().includes(q)).map((n) => n.id);
    this.visual.searchMatches = new Set(this.matchIds);
    this.matchCursor = 0;
    this.searchCountEl.setText(
      this.matchIds.length === 0 ? "no matches" : `${this.matchIds.length} match${this.matchIds.length === 1 ? "" : "es"}`
    );
    this.requestRender();
  }
  /** Enter: walk through the matches (camera + selection move with them). */
  focusNextMatch() {
    if (this.matchIds.length === 0) return;
    const id = this.matchIds[this.matchCursor % this.matchIds.length];
    this.matchCursor = (this.matchCursor + 1) % this.matchIds.length;
    this.focusNode(id, true);
  }
  clearSearch() {
    this.searchEl.value = "";
    this.visual.searchMatches = null;
    this.matchIds = [];
    this.matchCursor = 0;
    this.searchCountEl.setText("");
    this.requestRender();
  }
  /**
   * Note → graph integration: fly the camera to a note by path and select it.
   * Called from the plugin's "reveal current note in graph" command.
   */
  revealNote(path4) {
    const id = `note:${path4}`;
    if (this.model?.nodes.some((n) => n.id === id)) {
      this.focusNode(id, true);
    }
  }
  /** Open the real note behind a node (resolved notes only). */
  openNote(node) {
    if (node.kind !== "note" || node.unresolved) return;
    void this.app.workspace.openLinkText(node.label, "", false);
  }
  // ---- details panel ---------------------------------------------------------
  renderDetails() {
    const id = this.visual.selectedId;
    const node = id ? this.model?.nodes.find((n) => n.id === id) : null;
    this.detailsEl.empty();
    if (!id || !node || !this.model) {
      this.detailsEl.hide();
      return;
    }
    const neighbors = (this.model.adjacency.get(id) ?? []).map((nid) => this.model.nodes.find((n) => n.id === nid)).filter((n) => !!n);
    this.detailsEl.show();
    const head = this.detailsEl.createDiv({ cls: "sovereign-graph-details-head" });
    head.createSpan({
      text: node.label,
      cls: "sovereign-graph-details-title",
      attr: { title: node.kind === "note" ? id.slice(5) : `#${node.label}` }
    });
    const close = head.createSpan({
      cls: "sovereign-graph-details-close",
      attr: { "aria-label": "Clear selection", role: "button", tabindex: "0" }
    });
    close.setText("\u2715");
    const clear = () => this.select(null);
    close.addEventListener("click", clear);
    close.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") clear();
    });
    const meta = this.detailsEl.createDiv({ cls: "sovereign-graph-details-meta" });
    const kindLabel = node.kind === "tag" ? "TAG" : node.unresolved ? "UNRESOLVED LINK" : "NOTE";
    meta.createSpan({ text: kindLabel, cls: "sovereign-graph-details-kind" });
    meta.createSpan({
      text: `${neighbors.length} connection${neighbors.length === 1 ? "" : "s"}`,
      cls: "sovereign-graph-details-count"
    });
    const cluster = this.clusters.find((c) => c.id === this.clusterOf.get(id));
    if (cluster && cluster.size >= MIN_REGION_SIZE) {
      const groupRow = this.detailsEl.createDiv({ cls: "sovereign-graph-details-group" });
      const groupLink = groupRow.createSpan({
        cls: "sovereign-graph-details-group-link",
        attr: {
          role: "button",
          tabindex: "0",
          title: cluster.labelSource === "tag" ? "Connected group, named after the most common tag among its notes" : cluster.labelSource === "hub" ? "Connected group, named after its most connected note" : "Connected group"
        }
      });
      groupLink.setText(`Connected group \xB7 ${cluster.label} \xB7 ${cluster.size} notes`);
      const focusGroup = () => this.focusCluster(cluster.id);
      groupLink.addEventListener("click", focusGroup);
      groupLink.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          focusGroup();
        }
      });
    }
    if (neighbors.length > 0) {
      const rel = this.detailsEl.createDiv({ cls: "sovereign-graph-details-related" });
      rel.createDiv({ text: "RELATED", cls: "sovereign-graph-details-sub" });
      const list = rel.createDiv({ cls: "sovereign-graph-details-list" });
      for (const n of neighbors.slice(0, 6)) {
        const row = list.createSpan({ cls: "sovereign-graph-details-rel" });
        row.setText(n.label);
        row.addEventListener("click", () => this.focusNode(n.id, true));
      }
      if (neighbors.length > 6) {
        rel.createDiv({
          text: `${neighbors.length - 6} more connection${neighbors.length - 6 === 1 ? "" : "s"}`,
          cls: "sovereign-graph-details-more"
        });
      }
    }
    const actions = this.detailsEl.createDiv({ cls: "sovereign-graph-details-actions" });
    if (node.kind === "note" && !node.unresolved) {
      const open = actions.createEl("button", { text: "Open note", cls: "sovereign-graph-details-btn" });
      open.addEventListener("click", () => this.openNote(node));
    }
    const focusBtn = actions.createEl("button", {
      text: "Focus neighborhood",
      cls: "sovereign-graph-details-btn"
    });
    focusBtn.addEventListener("click", () => {
      this.animateCameraTo(
        { x: -(this.positions.get(id)?.x ?? 0), y: -(this.positions.get(id)?.y ?? 0), zoom: Math.max(this.camera.zoom, 1.4) },
        true
      );
    });
    if (node.kind === "note") {
      const ask2 = actions.createEl("button", {
        text: "Ask Sovereign",
        cls: "sovereign-graph-details-btn sovereign-graph-details-ask"
      });
      ask2.addEventListener("click", () => {
        this.openAskForNode(node);
      });
    }
  }
  /** Hand a selected node to the Second Brain popup as real context. */
  openAskForNode(node) {
    const path4 = node.kind === "note" ? node.id.slice("note:".length) : void 0;
    this.pluginInstance.askSovereign(void 0, {
      label: node.label,
      path: node.unresolved ? void 0 : path4
    });
  }
  // ---- interaction -----------------------------------------------------------
  nodeAt(sx, sy) {
    if (!this.model) return null;
    const vp = this.viewport();
    let best = null;
    for (let i = this.model.nodes.length - 1; i >= 0; i--) {
      const node = this.model.nodes[i];
      const pos = this.positions.get(node.id);
      if (!pos) continue;
      const s = worldToScreen(pos, this.camera, vp);
      const r = effectiveRadius(this.model, node) * this.camera.zoom;
      const hit = Math.max(10, r + 4);
      const dx = sx - s.x;
      const dy = sy - s.y;
      const dSq = dx * dx + dy * dy;
      if (dSq <= hit * hit && (!best || dSq < best.distSq)) {
        best = { node, distSq: dSq };
      }
    }
    return best?.node ?? null;
  }
  /** The currently selected node, when there is one. */
  selectedNode() {
    const id = this.visual.selectedId;
    if (!id || !this.model) return null;
    return this.model.nodes.find((n) => n.id === id) ?? null;
  }
  /** Notes ordered by real connection count — the keyboard traversal order. */
  orderedNodeIds() {
    if (!this.model) return [];
    return [...this.model.nodes].sort((a, b) => {
      const da = this.model.adjacency.get(a.id)?.length ?? 0;
      const db = this.model.adjacency.get(b.id)?.length ?? 0;
      return db - da || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    }).map((n) => n.id);
  }
  cycleSelection(delta) {
    const order = this.orderedNodeIds();
    if (order.length === 0) return;
    const current = this.visual.selectedId;
    const index = current ? order.indexOf(current) : -1;
    const next = ((index + delta) % order.length + order.length) % order.length;
    this.focusNode(order[next], true);
  }
  /**
   * Keyboard surface: the graph is fully explorable without a pointer.
   * Arrow keys move by real connection count, Enter opens, F fits, Escape
   * clears. The canvas owns focus, so these never fight the search field.
   */
  attachKeyboardEvents() {
    this.canvas.addEventListener("keydown", (e) => {
      switch (e.key) {
        case "ArrowRight":
        case "ArrowDown":
          e.preventDefault();
          this.cycleSelection(1);
          return;
        case "ArrowLeft":
        case "ArrowUp":
          e.preventDefault();
          this.cycleSelection(-1);
          return;
        case "Enter": {
          const node = this.selectedNode();
          if (node && node.kind === "note" && !node.unresolved) {
            e.preventDefault();
            this.openNote(node);
          }
          return;
        }
        case "f":
        case "F":
          e.preventDefault();
          this.fitToContent(true);
          this.announce("Fitted the whole map.");
          return;
        case "Escape":
          e.preventDefault();
          this.select(null);
          this.clearSearch();
          return;
        default:
          return;
      }
    });
  }
  attachCanvasEvents() {
    const el = this.canvas;
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const vp = this.viewport();
      const before = screenToWorld(sx, sy, this.camera, vp);
      const factor = Math.exp(-e.deltaY * 16e-4);
      const zoom = Math.min(CAMERA_ZOOM_MAX, Math.max(CAMERA_ZOOM_MIN, this.camera.zoom * factor));
      const after = screenToWorld(sx, sy, { ...this.camera, zoom }, vp);
      this.camera = { zoom, x: this.camera.x + (before.x - after.x), y: this.camera.y + (before.y - after.y) };
      this.cameraTransition = null;
      this.requestRender();
    }, { passive: false });
    el.addEventListener("pointerdown", (e) => {
      el.setPointerCapture(e.pointerId);
      const rect = el.getBoundingClientRect();
      const node = this.nodeAt(e.clientX - rect.left, e.clientY - rect.top);
      if (e.button === 1 || !node && e.button === 0 && e.ctrlKey) {
        this.panning = true;
      } else if (node) {
        this.draggingNode = node.id;
        this.dragMoved = false;
      } else if (e.button === 0) {
        this.panning = true;
      }
      this.lastPointer = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener("pointermove", (e) => {
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      if (this.draggingNode) {
        const vp = this.viewport();
        const world = screenToWorld(sx, sy, this.camera, vp);
        this.positions.set(this.draggingNode, { x: world.x, y: world.y });
        this.layoutPositions.set(this.draggingNode, { x: world.x, y: world.y });
        this.dragMoved = true;
        this.requestRender();
        return;
      }
      if (this.panning && this.lastPointer) {
        const dx = (e.clientX - this.lastPointer.x) / this.camera.zoom;
        const dy = (e.clientY - this.lastPointer.y) / this.camera.zoom;
        this.camera = { ...this.camera, x: this.camera.x + dx, y: this.camera.y + dy };
        this.cameraTransition = null;
        this.lastPointer = { x: e.clientX, y: e.clientY };
        this.requestRender();
        return;
      }
      const node = this.nodeAt(sx, sy);
      const next = node ? node.id : null;
      if (next !== this.visual.hoverId) {
        this.visual.hoverId = next;
        el.style.cursor = node ? "pointer" : "grab";
        this.requestRender();
      }
    });
    const endPointer = (e) => {
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      if (this.draggingNode) {
        const node = this.model?.nodes.find((n) => n.id === this.draggingNode);
        if (node && !this.dragMoved) {
          if (this.visual.selectedId === node.id && node.kind === "note" && !node.unresolved) {
            this.openNote(node);
          } else {
            this.select(node.id);
          }
        }
        this.draggingNode = null;
      }
      this.panning = false;
      this.lastPointer = null;
    };
    el.addEventListener("pointerup", endPointer);
    el.addEventListener("pointercancel", endPointer);
    el.addEventListener("click", (e) => {
      if (this.dragMoved) {
        this.dragMoved = false;
        return;
      }
      const rect = el.getBoundingClientRect();
      const node = this.nodeAt(e.clientX - rect.left, e.clientY - rect.top);
      if (!node && !this.panning) this.select(null);
    });
    el.addEventListener("dblclick", (e) => {
      const rect = el.getBoundingClientRect();
      const node = this.nodeAt(e.clientX - rect.left, e.clientY - rect.top);
      if (node && node.kind === "note" && !node.unresolved) {
        e.preventDefault();
        this.openNote(node);
      }
    });
    el.addEventListener("touchmove", (e) => {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      const [a, b] = [e.touches[0], e.touches[1]];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (this.pinchDist !== null) {
        const factor = dist / this.pinchDist;
        const zoom = Math.min(CAMERA_ZOOM_MAX, Math.max(CAMERA_ZOOM_MIN, this.camera.zoom * factor));
        this.camera = { ...this.camera, zoom };
        this.cameraTransition = null;
        this.requestRender();
      }
      this.pinchDist = dist;
    }, { passive: false });
    el.addEventListener("touchend", () => {
      this.pinchDist = null;
    });
  }
};

// src/views/SovereignPanelView.ts
var import_obsidian6 = require("obsidian");
var VIEW_TYPE_SOVEREIGN_PANEL = "sovereign-panel";
var SovereignPanelView = class extends import_obsidian6.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.mode = "overview";
  }
  getViewType() {
    return VIEW_TYPE_SOVEREIGN_PANEL;
  }
  getDisplayText() {
    return "Sovereign";
  }
  getIcon() {
    return "brain";
  }
  async onOpen() {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass("sovereign-panel-root");
    const head = root.createDiv({ cls: "sovereign-panel-head" });
    head.createSpan({ text: "\u2726", cls: "sovereign-panel-mark" });
    head.createSpan({ text: "SOVEREIGN", cls: "sovereign-panel-title" });
    const ask2 = head.createEl("button", { text: "Ask", cls: "sovereign-panel-ask" });
    ask2.addEventListener("click", () => this.plugin.askSovereign());
    const nav = root.createDiv({ cls: "sovereign-panel-nav" });
    this.navButton(nav, "Your brain", "overview");
    this.navButton(nav, "Timeline", "timeline");
    this.navButton(nav, "Constellation", "constellation");
    const map = nav.createEl("button", { text: "Knowledge map", cls: "sovereign-panel-nav-btn" });
    map.addEventListener("click", () => void this.plugin.openKnowledgeMap());
    this.body = root.createDiv({ cls: "sovereign-panel-body" });
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => void this.render()));
    this.registerEvent(this.app.metadataCache.on("resolved", () => void this.render()));
    await this.render();
  }
  navButton(parent, text, mode) {
    const button = parent.createEl("button", { text, cls: "sovereign-panel-nav-btn" });
    button.addEventListener("click", () => {
      this.mode = mode;
      void this.render();
    });
  }
  section(title) {
    return this.body.createDiv({ cls: "sovereign-panel-section" }).createDiv({ text: title, cls: "sovereign-panel-label" }).parentElement;
  }
  async render() {
    if (!this.body?.isConnected) return;
    this.body.empty();
    if (this.mode === "timeline") return this.renderTimeline();
    if (this.mode === "constellation") return this.renderConstellation();
    const brain = this.plugin.brainData();
    const file = this.app.workspace.getActiveFile();
    const [{ health, offline }, context] = await Promise.all([brain.getHealthDetailed(), brain.getNoteContext(file?.path)]);
    if (!this.body.isConnected) return;
    const hero = this.body.createDiv({ cls: "sovereign-panel-overview" });
    hero.createDiv({ text: "YOUR BRAIN", cls: "sovereign-panel-label" });
    const stats = hero.createDiv({ cls: "sovereign-panel-stats" });
    [[health.indexed_notes, "Notes"], [health.pending_memories, "Memories to review"], [health.potential_contradictions, "Contradictions"]].forEach(([n, l]) => {
      const stat = stats.createDiv();
      stat.createEl("strong", { text: String(n) });
      stat.createSpan({ text: String(l) });
    });
    const current = this.section(file ? file.basename.toUpperCase() : "CURRENT CONTEXT");
    current.createDiv({ text: file ? "Sovereign is looking at the note you are editing." : "Open a note to see its local knowledge context.", cls: "sovereign-panel-muted" });
    for (const path4 of context.similar_notes) current.createEl("button", { text: path4.split("/").pop()?.replace(/\.md$/i, "") ?? path4, cls: "sovereign-panel-link" }).addEventListener("click", () => void this.app.workspace.openLinkText(path4, "", false));
    const attention = this.section("ATTENTION");
    attention.createDiv({ text: `${context.related_notes_count} related notes \xB7 ${context.potential_connections_count} possible connections`, cls: "sovereign-panel-muted" });
    attention.createDiv({ text: context.contradictions_count ? `${context.contradictions_count} contradiction${context.contradictions_count === 1 ? "" : "s"} needs review` : "No contradictions detected for this context", cls: "sovereign-panel-muted" });
    const status = this.body.createDiv({ cls: "sovereign-panel-status" });
    status.setText(offline ? "\u25CF Core offline" : "\u25CF Synced locally");
  }
  renderTimeline() {
    this.body.createDiv({ text: "KNOWLEDGE TIMELINE", cls: "sovereign-panel-label" });
    this.body.createDiv({ text: "Recent notes in your knowledge history", cls: "sovereign-panel-muted" });
    this.app.vault.getMarkdownFiles().sort((a, b) => b.stat.mtime - a.stat.mtime).slice(0, 10).forEach((file) => {
      const row = this.body.createEl("button", { cls: "sovereign-panel-timeline", text: `${new Date(file.stat.mtime).toLocaleDateString()}  ${file.basename}` });
      row.addEventListener("click", () => void this.app.workspace.openLinkText(file.path, "", false));
    });
  }
  renderConstellation() {
    this.body.createDiv({ text: "KNOWLEDGE CONSTELLATION", cls: "sovereign-panel-label" });
    this.body.createDiv({ text: "Your strongest real topic clusters", cls: "sovereign-panel-muted" });
    const counts = /* @__PURE__ */ new Map();
    this.app.vault.getMarkdownFiles().forEach((file) => (this.app.metadataCache.getFileCache(file)?.tags ?? []).forEach((tag) => counts.set(tag.tag, (counts.get(tag.tag) ?? 0) + 1)));
    [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([tag, count]) => {
      const star = this.body.createDiv({ cls: "sovereign-panel-star" });
      star.createSpan({ text: "\u2726" });
      star.createSpan({ text: tag.replace(/^#/, "") });
      star.createEl("small", { text: `${count} notes` });
    });
    const map = this.body.createEl("button", { text: "Explore on the knowledge map", cls: "sovereign-panel-explore" });
    map.addEventListener("click", () => void this.plugin.openKnowledgeMap());
  }
};

// src/vault/reasoning.ts
var DEFAULT_ASK_LIMIT = 6;
var ASK_REQUEST_TIMEOUT_MS = 6e4;
async function ask(client, query, limit = DEFAULT_ASK_LIMIT) {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    throw new Error("query must not be empty");
  }
  return client.request("brain.ask", {
    query: trimmed,
    limit: Math.min(Math.max(1, limit), 20)
  }, ASK_REQUEST_TIMEOUT_MS);
}

// src/vault/memory.ts
async function listMemories(client, status) {
  const result = await client.request("memory.list", {
    status: status ?? null
  });
  return result.memories;
}
async function acceptMemory(client, id) {
  const result = await client.request("memory.accept", { id });
  return result.memory;
}
async function rejectMemory(client, id) {
  const result = await client.request("memory.reject", { id });
  return result.memory;
}
async function supersedeMemory(client, id, content, type) {
  const result = await client.request("memory.supersede", {
    id,
    content,
    type: type ?? null
  });
  return result.memory;
}
async function listContradictions(client) {
  const result = await client.request(
    "contradiction.list",
    {}
  );
  return result.contradictions;
}

// src/vault/health.ts
async function healthSummary(client) {
  return client.request("health.summary", {});
}

// src/vault/agent.ts
async function listActivity(client, limit = 100) {
  return client.request("activity.list", {
    limit
  });
}

// src/vault/search.ts
var MAX_SEARCH_LIMIT = 100;
async function searchQuery(client, query, limit = 20) {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  const capped = Math.min(Math.max(1, limit), MAX_SEARCH_LIMIT);
  const result = await client.request("search.query", {
    query: trimmed,
    limit: capped
  });
  return result.hits;
}

// src/services/brainDataService.ts
function daemonClient(daemon) {
  return {
    request: (method, params, timeoutMs) => daemon.request(method, params, timeoutMs),
    getStatus: () => daemon.getStatus()
  };
}
var OFFLINE_ANSWER = "The Sovereign core is not running. Start it (or check the plugin settings) \u2014 your notes are safe and nothing was modified.";
function confidenceOf(score) {
  if (score >= 0.7) return "high";
  if (score >= 0.35) return "medium";
  return "low";
}
function memoryTypeOf(type) {
  switch (type) {
    case "goal":
      return "goal";
    case "preference":
      return "preference";
    case "decision":
      return "decision";
    default:
      return "experience";
  }
}
function uiStatusOf(status) {
  return status === "candidate" ? "pending" : status;
}
function relTime(ms) {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 6e4);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function pathTitle(path4) {
  return path4.split("/").pop() ?? path4;
}
var RealBrainDataService = class {
  constructor(client) {
    this.client = client;
  }
  /** The active client, or null while the core is offline. */
  active() {
    const c = this.client();
    return c && c.getStatus() === "running" ? c : null;
  }
  /** `brain.ask` (§58) mapped to the Ask view model. */
  async queryBrain(query) {
    const client = this.active();
    if (!client) return this.offlineAsk(query);
    const result = await ask(client, query);
    const sources = result.sources.map((s) => ({
      path: s.note_path,
      title: pathTitle(s.note_path),
      excerpt: s.snippet.replace(/[«»]/g, ""),
      score: s.score
    }));
    const memories = result.memories.map((m) => ({
      id: m.id,
      statement: m.content,
      type: memoryTypeOf(m.type)
    }));
    const conflicts = result.contradictions.map((c) => ({
      earlier: c.claim_a.object,
      earlier_source: c.claim_a.note_path ?? "unknown note",
      later: c.claim_b.object,
      later_source: c.claim_b.note_path ?? "unknown note",
      interpretation: `Detected ${c.kind.replace(/_/g, " ")}; review both sources before deciding.`
    }));
    return {
      query,
      answer: result.answer,
      confidence: confidenceOf(result.confidence),
      sources,
      memories,
      conflicts: conflicts.length > 0 ? conflicts : void 0
    };
  }
  offlineAsk(query) {
    return {
      query,
      answer: OFFLINE_ANSWER,
      confidence: "low",
      sources: [],
      memories: []
    };
  }
  /** Current-note context (§17) from real retrieval + memory data. */
  async getNoteContext(path4) {
    const client = this.active();
    const offline = {
      path: path4 ?? "",
      title: path4 ? pathTitle(path4) : "No note open",
      related_notes_count: 0,
      memories_count: 0,
      potential_connections_count: 0,
      contradictions_count: 0,
      similar_notes: []
    };
    if (!client || !path4) return offline;
    try {
      const [hits, memories, contradictions] = await Promise.all([
        searchQuery(client, pathTitle(path4).replace(/\.md$/i, ""), 6),
        listMemories(client),
        listContradictions(client)
      ]);
      const related = hits.filter((h) => h.note_path !== path4);
      const relevant = memories.filter(
        (m) => m.status === "accepted" || m.status === "candidate"
      );
      return {
        path: path4,
        title: pathTitle(path4),
        related_notes_count: related.length,
        memories_count: relevant.length,
        potential_connections_count: Math.max(0, related.length - 1),
        contradictions_count: contradictions.length,
        similar_notes: related.slice(0, 3).map((h) => h.note_path)
      };
    } catch {
      return offline;
    }
  }
  /** `memory.list` over all statuses → the review UI model. */
  async getMemories() {
    const client = this.active();
    if (!client) return [];
    const entries = await listMemories(client);
    return entries.map((m) => ({
      id: m.id,
      statement: m.content,
      type: memoryTypeOf(m.type),
      status: uiStatusOf(m.status),
      source_path: m.sources.find((s) => s.note_path)?.note_path ?? "unknown",
      confidence: m.user_verified ? "high" : m.confidence >= 0.8 ? "high" : "medium",
      created_at: new Date(m.created_at).toISOString().slice(0, 10)
    }));
  }
  /** Memory review transitions (§50; user-driven only). */
  async setMemoryStatus(id, status) {
    const client = this.active();
    if (!client) return;
    if (status === "accepted") await acceptMemory(client, id);
    else if (status === "rejected") await rejectMemory(client, id);
    else if (status === "superseded") await supersedeMemory(client, id, "Superseded by user review");
  }
  /** `health.summary` (§68) → the health cards; prefer `getHealthDetailed`. */
  async getHealthMetrics() {
    const { health } = await this.getHealthDetailed();
    return health;
  }
  /**
   * Richer health fetch: the component uses this when it wants contradiction
   * and memory-review counts in one round trip.
   */
  async getHealthDetailed() {
    const client = this.active();
    if (!client) {
      return {
        health: {
          indexed_notes: 0,
          pending_memories: 0,
          potential_contradictions: 0,
          stale_knowledge: 0,
          duplicate_notes: 0,
          broken_links: 0
        },
        offline: true
      };
    }
    const [summary, contradictions, memories] = await Promise.all([
      healthSummary(client),
      listContradictions(client),
      listMemories(client, "candidate")
    ]);
    return {
      offline: false,
      health: {
        indexed_notes: summary.total_notes,
        pending_memories: memories.length,
        potential_contradictions: contradictions.length,
        stale_knowledge: 0,
        // stale memory listing arrives with §55 UI review
        duplicate_notes: summary.duplicate_candidates.length,
        broken_links: summary.broken_links.length
      }
    };
  }
  /** `activity.list` (§66) → the audit timeline; category from the event kind. */
  async getActivity() {
    const client = this.active();
    if (!client) return [];
    const { events } = await listActivity(client, 50);
    return events.map((e) => ({
      id: e.id,
      timestamp: relTime(e.created_at),
      title: e.result.replace(/[_.]/g, " "),
      detail: e.reason ?? void 0,
      category: e.result.includes("operation") ? "action" : "sync"
    }));
  }
  /** The audit trail plus chain verification (§66), for the Activity tab. */
  async getActivityWithChain() {
    const client = this.active();
    if (!client) return { events: [], chain_valid: true };
    const { events, chain_valid } = await listActivity(client, 50);
    return {
      chain_valid,
      events: events.map((e) => ({
        id: e.id,
        timestamp: relTime(e.created_at),
        title: e.result.replace(/[_.]/g, " "),
        detail: e.reason ?? void 0,
        category: e.result.includes("operation") ? "action" : "sync"
      }))
    };
  }
  /** Whether the core is currently serving. */
  isOnline() {
    return this.active() !== null;
  }
  /** Direct client access for surfaces that need raw protocol methods. */
  getClient() {
    const client = this.active();
    if (!client) throw new Error("core not running");
    return client;
  }
};

// src/main.ts
init_ollama();
var SovereignSecondBrainPlugin = class extends import_obsidian7.Plugin {
  constructor() {
    super(...arguments);
    this.settings = { ...DEFAULT_SETTINGS };
    this.daemon = null;
    this.brain = null;
    this.syncInFlight = null;
    this.syncQueued = false;
    this.ollamaWatchInFlight = false;
    /**
     * Boot gating for the core: `onload` never blocks Obsidian startup, so all
     * core-dependent actions must wait on this. It resolves (never rejects) once
     * the first `startDaemon()` attempt has settled — success or honest failure.
     */
    this.bootPromise = null;
  }
  async onload() {
    await this.loadSettings();
    this.registerView(
      VIEW_TYPE_SOVEREIGN_GRAPH,
      (leaf) => new SovereignGraphView(leaf, this)
    );
    this.registerView(
      VIEW_TYPE_SOVEREIGN_PANEL,
      (leaf) => new SovereignPanelView(leaf, this)
    );
    this.addRibbonIcon("brain", "Sovereign Brain (overlay)", () => {
      this.openOverlay();
    });
    this.addRibbonIcon("panel-left", "Open Sovereign panel", () => {
      void this.activateSovereignPanel();
    });
    this.addRibbonIcon("git-fork", "Sovereign knowledge graph", () => {
      void this.activateGraphView();
    });
    this.addCommand({
      id: "open-sovereign-overlay",
      name: "Open Sovereign Brain",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "b" }],
      callback: () => {
        this.openOverlay();
      }
    });
    this.addCommand({
      id: "restart-sovereign-core",
      name: "Restart core",
      callback: () => {
        void this.restartCore();
      }
    });
    this.addCommand({
      id: "open-sovereign-graph",
      name: "Open knowledge graph",
      callback: () => {
        void this.activateGraphView();
      }
    });
    this.addCommand({
      id: "open-sovereign-panel",
      name: "Open Sovereign panel",
      callback: () => void this.activateSovereignPanel()
    });
    this.addCommand({
      id: "reveal-note-in-sovereign-graph",
      name: "Reveal current note in knowledge graph",
      callback: () => {
        void this.revealNoteInGraph();
      }
    });
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof import_obsidian7.TFile) || file.extension !== "md") return;
        menu.addItem(
          (item) => item.setTitle("Show in Sovereign knowledge graph").setIcon("git-fork").onClick(() => void this.revealNoteInGraph(file.path))
        );
      })
    );
    this.addCommand({
      id: "run-sovereign-setup",
      name: "Run setup wizard",
      callback: () => {
        new SetupWizardModal(this.app, this).open();
      }
    });
    this.addSettingTab(new SovereignBrainSettingTab(this.app, this));
    this.bootPromise = this.startDaemon().catch(() => void 0).then(() => void 0);
    if (!this.settings.onboardingComplete) {
      this.app.workspace.onLayoutReady(() => {
        new SetupWizardModal(this.app, this).open();
      });
    }
  }
  /**
   * RELATED notes for an answer: other notes that are actually linked to or
   * from the answer's sources, straight from Obsidian's link cache. Real links
   * only, ranked by how many of the sources touch them, capped at four.
   */
  relatedNotesFor(sourcePaths) {
    if (sourcePaths.length === 0) return [];
    const resolved = this.app.metadataCache.resolvedLinks ?? {};
    const incoming = /* @__PURE__ */ new Map();
    for (const [from, targets] of Object.entries(resolved)) {
      for (const target of Object.keys(targets)) {
        const bucket = incoming.get(target);
        if (bucket) bucket.push(from);
        else incoming.set(target, [from]);
      }
    }
    const cited = new Set(sourcePaths);
    const counts = /* @__PURE__ */ new Map();
    const consider = (path4) => {
      if (!path4.endsWith(".md") || cited.has(path4)) return;
      counts.set(path4, (counts.get(path4) ?? 0) + 1);
    };
    for (const path4 of sourcePaths) {
      for (const target of Object.keys(resolved[path4] ?? {})) consider(target);
      for (const from of incoming.get(path4) ?? []) consider(from);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 4).map(([path4]) => ({
      path: path4,
      title: (path4.split("/").pop() ?? path4).replace(/\.md$/i, "")
    }));
  }
  /** BorderBeam configuration for the popup, from settings. */
  beamOptions() {
    return {
      size: this.settings.beamSize,
      color: this.settings.beamColor,
      strength: this.settings.beamStrength,
      active: true
    };
  }
  /**
   * Where the user actually is: the active note plus any selected text. This
   * is real editor state (never inferred), handed to the overlay so a question
   * asked from inside a note is answered in that note's context.
   */
  currentNoteContext() {
    const file = this.app.workspace.getActiveFile();
    if (!file) return void 0;
    const editor = this.app.workspace.activeEditor?.editor;
    const selected = editor?.getSelection().trim();
    return {
      label: file.basename,
      path: file.path,
      selectedText: selected && selected.length > 0 ? selected : void 0
    };
  }
  /** Open the overlay popup with the current services and editor context. */
  openOverlay() {
    openSovereignOverlay(
      this.app,
      {
        brain: this.brainData(),
        beam: this.beamOptions(),
        related: (paths) => this.relatedNotesFor(paths)
      },
      { context: this.currentNoteContext() }
    );
  }
  /**
   * Programmatic ask (graph → "Ask Sovereign"). The query is passed verbatim —
   * callers own the wording; nothing is synthesized here. `context` is the real
   * knowledge the user selected in the graph.
   */
  askSovereign(query, context) {
    openSovereignOverlay(
      this.app,
      {
        brain: this.brainData(),
        beam: this.beamOptions(),
        related: (paths) => this.relatedNotesFor(paths)
      },
      { query, context: context ?? this.currentNoteContext() }
    );
  }
  /** Reveal (or create) the knowledge graph leaf in the left sidebar. */
  async openKnowledgeMap() {
    await this.activateGraphView();
  }
  async activateSovereignPanel() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_SOVEREIGN_PANEL)[0];
    if (existing) {
      workspace.revealLeaf(existing);
      return;
    }
    const leaf = workspace.getLeftLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE_SOVEREIGN_PANEL, active: true });
      workspace.revealLeaf(leaf);
    }
  }
  async activateGraphView() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_SOVEREIGN_GRAPH)[0];
    if (existing) {
      workspace.revealLeaf(existing);
      return;
    }
    const leftLeaf = workspace.getLeftLeaf(false);
    if (leftLeaf) {
      await leftLeaf.setViewState({
        type: VIEW_TYPE_SOVEREIGN_GRAPH,
        active: true
      });
      workspace.revealLeaf(leftLeaf);
    }
  }
  /**
   * Note → graph integration: open (or reveal) the knowledge map and fly the
   * camera to a note. Defaults to the command palette's active file.
   */
  async revealNoteInGraph(path4) {
    const target = path4 ?? this.app.workspace.getActiveFile()?.path;
    await this.activateGraphView();
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_SOVEREIGN_GRAPH)[0];
    const view = leaf?.view;
    if (view instanceof SovereignGraphView && target) {
      view.revealNote(target);
    }
  }
  onunload() {
    if (this.ollamaWatchTimer !== void 0) {
      window.clearInterval(this.ollamaWatchTimer);
      this.ollamaWatchTimer = void 0;
    }
    const daemon = this.daemon;
    this.daemon = null;
    if (daemon) void daemon.stop();
  }
  /** Access for later workstreams (views, commands) — not for UI styling. */
  getDaemon() {
    return this.daemon;
  }
  /** Lazily start the daemon if it isn't running (wizard re-entry path). */
  async ensureDaemon() {
    if (this.bootPromise) await this.bootPromise;
    if (this.daemon && this.daemon.getStatus() === "running") return;
    await this.startDaemon();
  }
  /**
   * A fresh client closure bound to the current daemon. Used by surfaces
   * that need raw protocol access (settings model status, wizard).
   */
  getClientFactory() {
    return () => this.daemon ? daemonClient(this.daemon) : null;
  }
  /** Services wired to the live daemon; null-client closures when offline. */
  brainData() {
    this.brain = this.brain ?? new RealBrainDataService(() => this.daemon ? daemonClient(this.daemon) : null);
    return this.brain;
  }
  /** Trigger an incremental sync (coalesced if one is already running). */
  syncNow() {
    if (this.syncInFlight) {
      this.syncQueued = true;
      return this.syncInFlight;
    }
    this.syncInFlight = this.performSync(false).catch((err) => {
      if (!(err instanceof SyncAbortedError)) {
        console.error("[sovereign] sync failed:", err);
      }
    }).finally(() => {
      this.syncInFlight = null;
      if (this.syncQueued) {
        this.syncQueued = false;
        void this.syncNow();
      }
    });
    return this.syncInFlight;
  }
  async performSync(rebuild) {
    const daemon = this.daemon;
    if (!daemon) return;
    const outcome = await runSync(
      {
        begin: (rebuild2) => daemon.request("vault.sync.begin", { rebuild: rebuild2 }),
        batch: (sid, notes) => daemon.request("vault.sync.batch", { session_id: sid, notes }),
        commit: (sid) => daemon.request("vault.sync.commit", { session_id: sid }),
        readNote: (p) => readNote(this.app.vault, p),
        uploadNote: (sid, note) => daemon.request("vault.sync.note", { session_id: sid, ...note }),
        finish: (sid) => daemon.request("vault.sync.finish", { session_id: sid })
      },
      await buildInventory(this.app.vault),
      {
        rebuild,
        shouldAbort: () => this.daemon === null
      }
    );
    console.info(
      `[sovereign] synced: +${outcome.added.length} ~${outcome.modified.length} \u2192${outcome.renamed.length} -${outcome.deleted.length} (total ${outcome.totalNotes})`
    );
  }
  /**
   * Obsidian's `manifest.dir` is a **vault-relative** path. Anything that
   * touches the filesystem (the core binary) must resolve it against the
   * vault root first — otherwise every candidate is probed relative to
   * Obsidian's own working directory, never matches, and the plugin reports
   * "the Sovereign core is not running" even though the binary is right there.
   */
  pluginDirPath() {
    const dir = this.manifest.dir ?? "";
    if (dir && path3.isAbsolute(dir)) return dir;
    const root = this.vaultRoot();
    if (root) {
      return dir ? path3.join(root, dir) : path3.join(root, ".obsidian", "plugins", this.manifest.id);
    }
    return path3.resolve(dir);
  }
  /** Absolute vault root on desktop; null when the adapter cannot report one. */
  vaultRoot() {
    const adapter = this.app.vault.adapter;
    try {
      if (typeof adapter.getBasePath === "function") return adapter.getBasePath();
    } catch {
    }
    return null;
  }
  /** Where the core binary was found (or the search space that failed). */
  resolveCore() {
    const configured = this.settings.coreBinaryPath.trim();
    if (configured) return { path: configured, searched: [configured] };
    return resolveCoreBinaryDetailed({
      pluginDir: this.pluginDirPath(),
      vaultRoot: this.vaultRoot()
    });
  }
  /** Core process status for diagnostics surfaces (settings tab). */
  coreStatus() {
    return this.daemon?.getStatus() ?? "stopped";
  }
  /**
   * Start (or report why the core could not start). Returns a one-line
   * diagnostic so commands/settings can surface the real reason instead of a
   * generic "offline" state.
   */
  async startDaemon() {
    const resolution = this.resolveCore();
    const binaryPath = resolution.path;
    if (!binaryPath) {
      console.warn(
        "[sovereign] core binary not found. Searched:\n  " + resolution.searched.join("\n  ")
      );
      const detail = `Sovereign core binary not found (${resolution.searched.length} locations searched). Run ./scripts/install.sh \u2014 it copies sovereign-core next to the plugin \u2014 or set the core binary path in Sovereign settings. Your notes were not modified.`;
      new import_obsidian7.Notice(detail, 12e3);
      return detail;
    }
    const dataDir = this.settings.dataDir || path3.join(os.homedir(), "SovereignBrain");
    this.daemon = new SovereignDaemon({
      binaryPath,
      dataDir,
      requestTimeoutMs: this.settings.requestTimeoutMs,
      onLog: (line) => console.debug("[sovereign-core]", line),
      onUnexpectedExit: (code, signal) => {
        console.warn(`[sovereign] core exited unexpectedly (code=${code} signal=${signal})`);
      }
    });
    try {
      const health = await this.daemon.start();
      console.info(
        `[sovereign] core running v${health.version} (protocol v${health.protocol_version}, pid ${health.pid}) from ${binaryPath}`
      );
      this.attachVaultEvents();
      void this.syncNow();
      this.startOllamaWatcher();
      return `Sovereign core running (v${health.version}).`;
    } catch (err) {
      console.error("[sovereign] core failed to start:", err);
      const reason = err instanceof Error ? err.message : String(err);
      const detail = `Sovereign core failed to start: ${reason} Your notes were not modified.`;
      new import_obsidian7.Notice(detail, 12e3);
      return detail;
    }
  }
  /**
   * Stop and start the core on demand — the recovery path when the core died,
   * the binary moved, or settings changed. Never throws.
   */
  async restartCore() {
    const previous = this.daemon;
    this.daemon = null;
    if (previous) {
      try {
        await previous.stop();
      } catch (err) {
        console.debug("[sovereign] core stop during restart:", err);
      }
    }
    const detail = await this.startDaemon();
    new import_obsidian7.Notice(detail, 8e3);
    return detail;
  }
  attachVaultEvents() {
    const { watcher } = createVaultWatcher(this.app.vault, {
      scheduleSync: () => void this.syncNow()
    });
    const events = ["create", "modify", "delete", "rename"];
    for (const event of events) {
      this.registerEvent(this.app.vault.on(event, watcher));
    }
  }
  /**
   * Slow-cadence Ollama watcher: links a local Ollama automatically when it
   * is running now, or when it starts later. One shot per link: a Notice
   * plus a full re-embed, exactly once per establishment.
   */
  /** Restart the watcher after a settings change (no-op when disabled or offline). */
  restartOllamaWatcher() {
    if (this.ollamaWatchTimer !== void 0) {
      window.clearInterval(this.ollamaWatchTimer);
      this.ollamaWatchTimer = void 0;
    }
    if (this.settings.ollamaAutoLink && this.daemon?.getStatus() === "running") {
      this.startOllamaWatcher();
    }
  }
  startOllamaWatcher() {
    if (!this.settings.ollamaAutoLink) return;
    if (this.ollamaWatchTimer !== void 0) return;
    const check = async () => {
      if (this.ollamaWatchInFlight) return;
      this.ollamaWatchInFlight = true;
      try {
        const daemon = this.daemon;
        if (!daemon || daemon.getStatus() !== "running") return;
        const client = daemonClient(daemon);
        const status = await client.request("models.status", {});
        const linked = await autoLinkCheck(status.provider, {
          dataDir: this.settings.dataDir || path3.join(os.homedir(), "SovereignBrain"),
          request: (method, params) => client.request(method, params)
        });
        if (linked) {
          new import_obsidian7.Notice(linked.message, 8e3);
          if (linked.embedLinked !== false) {
            await this.performSync(true);
          }
        }
      } catch (err) {
        console.debug("[sovereign] ollama auto-link check skipped:", err);
      } finally {
        this.ollamaWatchInFlight = false;
      }
    };
    void check();
    this.ollamaWatchTimer = window.setInterval(() => void check(), OLLAMA_WATCH_INTERVAL_MS);
    this.registerInterval(this.ollamaWatchTimer);
  }
  /** Manual / wizard entry point: probe now and link when found. */
  async linkOllamaNow() {
    const { probeOllama: probeOllama2, linkOllamaToCore: linkOllamaToCore2 } = await Promise.resolve().then(() => (init_ollama(), ollama_exports));
    const probe = await probeOllama2(
      this.settings.ollamaBaseUrl || void 0
    );
    if (!probe.found) {
      return `Ollama not found at ${probe.baseUrl} (${probe.reason}). Start it with \`ollama serve\`.`;
    }
    const daemon = this.daemon;
    if (!daemon || daemon.getStatus() !== "running") {
      return "The core is not running, so Ollama cannot be linked right now.";
    }
    const client = daemonClient(daemon);
    const result = await linkOllamaToCore2(probe, {
      dataDir: this.settings.dataDir || path3.join(os.homedir(), "SovereignBrain"),
      request: (method, params) => client.request(method, params)
    });
    if (result.linked) {
      if (result.embedLinked !== false) {
        void this.performSync(true);
      }
    }
    return result.message;
  }
  async loadSettings() {
    const stored = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
};
