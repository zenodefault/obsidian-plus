import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseEnvelope } from "../src/utils/validate";

/** Shared contract fixtures — same file the Rust contract test consumes. */
function loadFixtures(): Array<{ name: string; valid: boolean; wire: unknown }> {
  const p = path.resolve(__dirname, "..", "..", "schemas", "protocol", "fixtures.jsonl");
  const raw = fs.readFileSync(p, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0 && !l.trim().startsWith("#"))
    .map((l) => JSON.parse(l));
}

describe("protocol fixtures (shared with core)", () => {
  it("exist and are meaningful", () => {
    expect(loadFixtures().length).toBeGreaterThanOrEqual(5);
  });

  it("parse exactly when marked valid, fail when marked invalid", () => {
    for (const f of loadFixtures()) {
      const parsed = parseEnvelope(JSON.stringify(f.wire));
      if (f.valid) {
        expect(parsed, `fixture ${f.name} should parse`).not.toBeNull();
      } else {
        expect(parsed, `fixture ${f.name} should be rejected`).toBeNull();
      }
    }
  });
});
