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
