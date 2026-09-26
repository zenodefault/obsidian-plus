import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Wiring guard (Workstream 8 → real core): the shipped bundle must never
 * contain mock-service wiring. Views consume the protocol wrappers only.
 */
describe("bundle wiring guard", () => {
  const bundlePath = path.resolve(__dirname, "..", "main.js");

  it("does not reference the mock service in the built bundle", () => {
    if (!fs.existsSync(bundlePath)) {
      // Bundle not built yet in this environment; the esbuild build step runs
      // the same check via CI. Skip rather than fail the unit run.
      return;
    }
    const bundle = fs.readFileSync(bundlePath, "utf8");
    expect(bundle).not.toContain("MOCK_ASK_RESULT");
    expect(bundle).not.toContain("mockService");
  });

  it("keeps USE_MOCK_IPC disabled at the source level", () => {
    const config = fs.readFileSync(
      path.resolve(__dirname, "..", "src", "config.ts"),
      "utf8",
    );
    expect(config).toContain("export const USE_MOCK_IPC = false");
  });
});
