/**
 * Ollama linking (Workstream: local LLM auto-setup).
 *
 * The user asked: "if a user has Ollama set up locally, it should set itself
 * up automatically; and when Ollama starts running later, the plugin should
 * link it automatically too."
 *
 * How it works without violating the core's network isolation (§96):
 * 1. This plugin (Electron, full Node) probes the local Ollama server at
 *    http://127.0.0.1:11434/api/tags. The core never opens sockets.
 * 2. On a match, the plugin installs a tiny stdio shim into the core's data
 *    dir that speaks the core's CLI-provider JSON contract and forwards to
 *    Ollama. The core then "spawns the user-configured local binary" — the
 *    exact mechanism it already supports — so no core networking and no new
 *    spawn sites exist (hardening tests stay green).
 * 3. The plugin persists the configuration via `models.configure`.
 * 4. A low-frequency watcher re-probes while the plugin is enabled, so an
 *    Ollama server that starts later is linked automatically.
 *
 * Nothing is silent: every decision logs, and a probe failure is an honest
 * "Ollama not found", never a fake success.
 */

import { requestUrl } from "obsidian";
import {
  installShim,
  ollamaBaseUrl,
  pickEmbeddingModel,
  pickGenerationModel,
  shimPathFor,
  shimState,
  type OllamaInstance,
  type OllamaTag,
} from "../onboarding/setupCheck";

/** Result of one probe against the local Ollama server. */
export type OllamaProbe =
  | ({ found: true } & OllamaInstance)
  | { found: false; baseUrl: string; reason: string };

/** Probe the local Ollama server for installed models. Never throws. */
export async function probeOllama(baseUrl = ollamaBaseUrl()): Promise<OllamaProbe> {
  try {
    const res = await requestUrl({
      url: `${baseUrl}/api/tags`,
      method: "GET",
      throw: false,
    });
    if (res.status !== 200) {
      return { found: false, baseUrl, reason: `HTTP ${res.status} from ${baseUrl}/api/tags` };
    }
    const body = res.json as { models?: Array<{ name?: string; size?: number; families?: string[] | null }> };
    const models: OllamaTag[] = (body.models ?? [])
      .filter((m) => typeof m.name === "string" && m.name.length > 0)
      .map((m) => ({ name: m.name as string, size_bytes: typeof m.size === "number" ? m.size : 0, families: m.families ?? null }));
    return { found: true, baseUrl, models };
  } catch (err) {
    // ECONNREFUSED etc — the normal "Ollama not running" case.
    const reason = err instanceof Error ? err.message : String(err);
    return { found: false, baseUrl, reason };
  }
}

/**
 * Verify the shim actually runs against the live server (one embed call —
 * or one generate call for a chat model, which cannot embed).
 * Spawns the shim exactly the way the core will: no arguments, JSON on
 * stdin, one JSON line on stdout.
 */
export function verifyShim(
  dataDir: string,
  model: string,
  role: "embed" | "generate" = "embed",
): Promise<{ ok: true; dimension: number } | { ok: false; reason: string }> {
  const shimPath = shimPathFor(dataDir);
  if (process.platform !== "win32" && !shimState(dataDir).installed) {
    return Promise.resolve({ ok: false, reason: `shim not installed or not executable: ${shimPath}` });
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: { ok: true; dimension: number } | { ok: false; reason: string }) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    // Lazy-require child_process: keeps the module importable in tests.
    const { spawn } = require("node:child_process") as typeof import("node:child_process");
    const bin = process.platform === "win32" ? `${shimPath}.cmd` : shimPath;
    const proc = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      done({ ok: false, reason: "shim did not answer within 15s (is python3 on PATH?)" });
    }, 15_000);

    let out = "";
    proc.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      done({ ok: false, reason: `failed to launch shim: ${err.message}` });
    });
    proc.on("exit", () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out) as { embeddings?: number[][]; text?: string; error?: string };
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
      role === "generate"
        ? JSON.stringify({ model, prompt: "Reply with the single word: ok" })
        : JSON.stringify({ model, texts: ["sovereign shim verification"] }),
    );
  });
}

/** The outcome of an end-to-end link attempt. */
export interface LinkResult {
  linked: boolean;
  /** Human explanation (Notice / settings card text). */
  message: string;
  model?: string;
  baseUrl?: string;
  /** True when the EMBEDDING provider changed (a full re-embed is due).
   * A generation-only link leaves every existing vector untouched. */
  embedLinked?: boolean;
}

/** Parameters for linking the local Ollama to the core. */
export interface OllamaLinkContext {
  /** Core data dir (shim install location). */
  dataDir: string;
  /** Send a protocol request to the core; null when the core is offline. */
  request: <T>(method: string, params: unknown) => Promise<T>;
}

/**
 * Link the running Ollama to the core:
 * install shim → models.configure → verify → (caller triggers re-embed when
 * embeddings changed).
 *
 * Embeddings and generation are configured separately (the core's model
 * layer keeps them apart by design):
 * - a dedicated embedding model (nomic-embed-text, …) becomes the embedding
 *   provider — it re-embeds the whole vault, so it must be an embed model;
 * - a chat model (qwen3, llama3, …) becomes the GENERATION model — asking
 *   it to embed would poison retrieval, but it is exactly right for drafting
 *   grounded answers. With only a chat model installed, the link succeeds
 *   with generation-only (answers work; hybrid search stays on the hash
 *   embedder until a real embedding model is pulled).
 *
 * Honest states: every failure explains itself; nothing pretends.
 */
export async function linkOllamaToCore(
  instance: OllamaInstance,
  ctx: OllamaLinkContext,
): Promise<LinkResult> {
  const { baseUrl } = instance;
  const embedModel = pickEmbeddingModel(instance.models);
  const genModel = pickGenerationModel(instance.models);
  if (!embedModel && !genModel) {
    return {
      linked: false,
      baseUrl,
      message:
        "Ollama is running but no suitable model is installed. Pull a model " +
        "(e.g. `ollama pull qwen3:4b` for answers, `ollama pull nomic-embed-text` " +
        "for better search) and the plugin will link it on its next check.",
    };
  }
  if (!ctx.dataDir) {
    return { linked: false, baseUrl, message: "Core data directory is not configured yet." };
  }

  let shimPath: string;
  try {
    shimPath = installShim(ctx.dataDir, baseUrl);
  } catch (err) {
    return {
      linked: false,
      baseUrl,
      message: `Could not install the Ollama shim: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!ctx.request) {
    return { linked: false, baseUrl, message: "Core is offline; the shim is installed but not linked." };
  }

  interface ConfigureResult {
    applied: boolean;
    validation_error?: string;
  }

  let embedLinked = false;
  let genLinked = false;

  if (embedModel) {
    try {
      const result = await ctx.request<ConfigureResult>("models.configure", {
        provider: "ollama",
        model_path: embedModel.name,
        binary_path: shimPath,
        base_url: baseUrl,
      });
      if (!result.applied) {
        return { linked: false, baseUrl, message: "The core refused the model configuration." };
      }
      if (result.validation_error) {
        return {
          linked: false,
          baseUrl,
          message: `Configuration stored but invalid: ${result.validation_error}`,
        };
      }
    } catch (err) {
      return {
        linked: false,
        baseUrl,
        message: `models.configure failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Verify the shim actually answers (honesty over optimism).
    const verify = await verifyShim(ctx.dataDir, embedModel.name);
    if (!verify.ok) {
      return {
        linked: false,
        baseUrl,
        message: `Shim verification failed: ${verify.reason}. Configuration is stored; the core will fall back to lexical search until it works.`,
      };
    }
    embedLinked = true;
  }

  if (genModel) {
    try {
      const result = await ctx.request<ConfigureResult>("models.configure", {
        provider: embedModel ? "ollama" : "hash",
        model_path: embedModel?.name,
        binary_path: embedModel ? shimPath : undefined,
        base_url: embedModel ? baseUrl : undefined,
        generation_model_path: genModel.name,
        generation_binary_path: shimPath,
        generation_base_url: baseUrl,
      });
      if (!result.applied || result.validation_error) {
        // Embeddings stay linked; generation degrades to evidence answers.
        if (embedLinked) {
          return {
            linked: true,
            baseUrl,
            model: embedModel?.name,
            message: `Linked Ollama for search (${embedModel?.name}); the generation model (${genModel.name}) was refused: ${result.validation_error ?? "rejected by the core"}.`,
          };
        }
        return {
          linked: false,
          baseUrl,
          message: `Configuration stored but invalid: ${result.validation_error ?? "rejected by the core"}`,
        };
      }
    } catch (err) {
      if (embedLinked) {
        return {
          linked: true,
          baseUrl,
          model: embedModel?.name,
          message: `Linked Ollama for search (${embedModel?.name}); the generation model could not be configured: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      return {
        linked: false,
        baseUrl,
        message: `models.configure failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Verify the generation path with a completion (a chat model cannot embed).
    const genVerify = await verifyShim(ctx.dataDir, genModel.name, "generate");
    if (!genVerify.ok) {
      if (embedLinked) {
        return {
          linked: true,
          baseUrl,
          model: embedModel?.name,
          message: `Linked Ollama for search (${embedModel?.name}); the generation model failed verification: ${genVerify.reason}.`,
        };
      }
      return {
        linked: false,
        baseUrl,
        message: `Shim verification failed: ${genVerify.reason}. Configuration is stored; answers will come from note evidence until it works.`,
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
      message: `Linked local Ollama (${embedModel?.name} for search, ${genModel?.name} for answers). Re-embedding the vault with it now.`,
    };
  }
  if (embedLinked) {
    return {
      linked: true,
      baseUrl,
      model: embedModel?.name,
      embedLinked: true,
      message: `Linked local Ollama (${embedModel?.name}). Re-embedding the vault with it now.`,
    };
  }
  return {
    linked: true,
    baseUrl,
    model: genModel?.name,
    embedLinked: false,
    message: `Linked local Ollama (${genModel?.name}) for answers. Search uses the built-in embedder; pull an embedding model (e.g. nomic-embed-text) for better retrieval.`,
  };
}

/**
 * One auto-link check cycle. Returns the result ONLY when a new link was
 * established this cycle (so the caller can notify + re-embed exactly once).
 * `alreadyLinkedProvider` prevents re-link churn on every cycle; a
 * generation-only link still counts as linked (answers work), so it also
 * suppresses churn — embedding upgrades happen via the settings' Link now.
 */
export async function autoLinkCheck(
  currentProvider: string | undefined,
  ctx: OllamaLinkContext | null,
): Promise<LinkResult | null> {
  if (currentProvider === "ollama") return null; // already linked; nothing to do
  const probe = await probeOllama();
  if (!probe.found) return null;
  if (!ctx) return null; // core offline — shim install would be pointless churn
  const result = await linkOllamaToCore(probe, ctx);
  return result.linked ? result : null;
}

/** Default probe cadence for the background watcher: 5 minutes. */
export const OLLAMA_WATCH_INTERVAL_MS = 5 * 60 * 1000;
