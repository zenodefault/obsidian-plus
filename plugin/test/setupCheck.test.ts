import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  coreBinaryCandidates,
  detectCoreBinary,
  probeBinaryPath,
  summarizeModelStatus,
  offlineModelSummary,
  ollamaBaseUrl,
  pickEmbeddingModel,
  pickGenerationModel,
  buildOllamaShimSource,
  shimState,
  OLLAMA_SHIM_NAME,
  type OllamaTag,
} from "../src/onboarding/setupCheck";

describe("core binary detection", () => {
  it("lists release, debug and plugin-bin candidates", () => {
    const candidates = coreBinaryCandidates("/vault/.obsidian/plugins/sovereign-second-brain");
    expect(candidates.length).toBe(3);
    expect(candidates[0]).toContain(path.join("core", "target", "release"));
    expect(candidates[2]).toContain(path.join("bin", "sovereign-core"));
  });

  it("finds an executable file at a probed path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-setup-"));
    const bin = path.join(dir, "sovereign-core");
    fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(bin, 0o755);
    const check = probeBinaryPath(bin);
    expect(check.ok).toBe(true);
    expect(check.path).toBe(bin);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a non-executable path honestly", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-setup-"));
    const plain = path.join(dir, "not-a-binary.txt");
    fs.writeFileSync(plain, "hello");
    const check = probeBinaryPath(plain);
    expect(check.ok).toBe(false);
    expect(check.message).toContain("Build it with");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("detectCoreBinary falls back to a not-found summary with the first guess", () => {
    const check = detectCoreBinary("/nonexistent/plugin/dir");
    expect(check.ok).toBe(false);
    expect(check.message).toContain("not detected");
    expect(check.path).toContain("core");
  });
});

describe("summarizeModelStatus", () => {
  it("describes the built-in hash embedder as zero-setup", () => {
    const summary = summarizeModelStatus({
      provider: "hash",
      dimension: 384,
      chunks_total: 10,
      chunks_embedded: 10,
      chunks_pending: 0,
    });
    expect(summary.builtin).toBe(true);
    expect(summary.problem).toBeUndefined();
    expect(summary.message).toContain("no model files");
  });

  it("surfaces a CLI validation error honestly, not as decoration", () => {
    const summary = summarizeModelStatus({
      provider: "cli",
      model_path: "/models/m.gguf",
      binary_path: "/bin/embedder",
      dimension: 0,
      chunks_total: 10,
      chunks_embedded: 0,
      chunks_pending: 10,
      validation_error: "model file not found: /models/m.gguf",
    });
    expect(summary.builtin).toBe(false);
    expect(summary.problem).toContain("model file not found");
    expect(summary.message).toContain("falls back");
  });

  it("reports a working CLI model as local", () => {
    const summary = summarizeModelStatus({
      provider: "cli",
      model_path: "/models/m.gguf",
      binary_path: "/bin/embedder",
      dimension: 768,
      chunks_total: 4,
      chunks_embedded: 4,
      chunks_pending: 0,
    });
    expect(summary.problem).toBeUndefined();
    expect(summary.message).toContain("stays on this machine");
  });

  it("gives the offline summary an honest unknown provider", () => {
    const summary = offlineModelSummary();
    expect(summary.provider).toBe("unknown");
    expect(summary.message).toContain("not running");
  });
});

describe("ollama detection helpers", () => {
  it("defaults the base URL to the local Ollama port", () => {
    expect(ollamaBaseUrl({})).toBe("http://127.0.0.1:11434");
  });

  it("honors OLLAMA_HOST in its three documented shapes", () => {
    expect(ollamaBaseUrl({ OLLAMA_HOST: "0.0.0.0:11434" })).toBe("http://0.0.0.0:11434");
    expect(ollamaBaseUrl({ OLLAMA_HOST: "localhost" })).toBe("http://localhost");
    expect(ollamaBaseUrl({ OLLAMA_HOST: "http://192.168.1.10:11434/" })).toBe(
      "http://192.168.1.10:11434",
    );
  });

  const tag = (name: string, size_bytes = 1000): OllamaTag => ({ name, size_bytes });

  it("prefers a dedicated embedding model, smallest first", () => {
    const picked = pickEmbeddingModel([
      tag("llama3.1:8b", 5_000_000_000),
      tag("nomic-embed-text:v1.5", 270_000_000),
      tag("mxbai-embed-large", 670_000_000),
    ]);
    expect(picked?.name).toBe("nomic-embed-text:v1.5");
  });

  it("never picks a chat model when anything else exists", () => {
    const picked = pickEmbeddingModel([tag("llama3.1:8b"), tag("mistral")]);
    expect(picked).toBeNull();
  });

  it("falls back to the smallest non-chat model when no embed model exists", () => {
    const picked = pickEmbeddingModel([tag("qwen2.5-coder:7b", 4_000_000_000), tag("snowflake-arctic-embed:s", 130_000_000)]);
    expect(picked?.name).toBe("snowflake-arctic-embed:s");
  });

  it("picks the chat model for generation when it is the only model installed", () => {
    // The user's exact scenario: Ollama running with only qwen3:4b.
    const picked = pickGenerationModel([tag("qwen3:4b", 2_600_000_000)]);
    expect(picked?.name).toBe("qwen3:4b");
  });

  it("generation never double-books the embedding pick", () => {
    const models = [tag("nomic-embed-text:v1.5", 270_000_000), tag("qwen3:4b", 2_600_000_000)];
    expect(pickEmbeddingModel(models)?.name).toBe("nomic-embed-text:v1.5");
    expect(pickGenerationModel(models)?.name).toBe("qwen3:4b");
  });

  it("generation prefers a chat family when several candidates exist", () => {
    const picked = pickGenerationModel([
      tag("some-random-7b", 4_000_000_000),
      tag("llama3.1:8b", 5_000_000_000),
    ]);
    expect(picked?.name).toBe("llama3.1:8b");
  });

  it("generation returns null when only one model exists and the embedder takes it", () => {
    const models = [tag("nomic-embed-text:v1.5", 270_000_000)];
    expect(pickEmbeddingModel(models)?.name).toBe("nomic-embed-text:v1.5");
    expect(pickGenerationModel(models)).toBeNull();
  });

  it("shim source speaks the core's exact CLI-provider contract", () => {
    const src = buildOllamaShimSource("http://127.0.0.1:11434");
    expect(src).toContain('/api/embed');
    expect(src).toContain('/api/generate');
    expect(src).toContain('"embeddings"');
    expect(src).toContain('"text"');
    expect(src).toContain('BASE_URL = "http://127.0.0.1:11434"');
    // No cloud endpoints, ever.
    expect(src).not.toContain("https://api.");
  });

  it("shimState reports installation honestly", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-shim-"));
    expect(shimState(dir).installed).toBe(false);
    fs.writeFileSync(path.join(dir, OLLAMA_SHIM_NAME), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const state = shimState(dir);
    expect(state.installed).toBe(true);
    expect(state.path).toBe(path.join(dir, OLLAMA_SHIM_NAME));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
