/**
 * Ollama service tests: pure filesystem + parsing logic only (the probe
 * itself needs Obsidian's requestUrl and is exercised by the shim-source
 * contract tests in setupCheck.test.ts).
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installShim, shimPathFor, shimState, buildOllamaShimSource } from "../src/onboarding/setupCheck";

describe("shim installation", () => {
  it("installs an executable shim and records its base URL", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-ollama-"));
    const shimPath = installShim(dir, "http://127.0.0.1:11434");

    expect(shimPath).toBe(shimPathFor(dir));
    const state = shimState(dir);
    expect(state.installed).toBe(true);
    expect(fs.readFileSync(shimPath, "utf8")).toBe(
      buildOllamaShimSource("http://127.0.0.1:11434"),
    );
    expect(fs.readFileSync(`${shimPath}.base-url`, "utf8").trim()).toBe(
      "http://127.0.0.1:11434",
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refreshes the shim when the base URL changes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-ollama-"));
    installShim(dir, "http://127.0.0.1:11434");
    installShim(dir, "http://0.0.0.0:11434");
    expect(fs.readFileSync(shimPathFor(dir), "utf8")).toContain(
      'BASE_URL = "http://0.0.0.0:11434"',
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates the data dir when missing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sv-ollama-"));
    const dir = path.join(root, "nested", "data");
    const shimPath = installShim(dir, "http://127.0.0.1:11434");
    expect(fs.existsSync(shimPath)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
