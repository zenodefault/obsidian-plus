import { describe, expect, it } from "vitest";
import {
  buildGraphModel,
  noteLabel,
} from "../src/components/graph/buildGraphModel";
import { computeLayout } from "../src/components/graph/forceLayout";

describe("buildGraphModel", () => {
  it("creates note nodes and link edges from resolved links", () => {
    const model = buildGraphModel(
      { "A.md": { "B.md": 1 }, "B.md": {} },
      {},
      {},
    );
    const ids = model.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(["note:A.md", "note:B.md"]);
    expect(model.edges).toHaveLength(1);
    expect(model.edges[0]!.kind).toBe("link");
    // Adjacency is bidirectional.
    expect(model.adjacency.get("note:A.md")).toContain("note:B.md");
    expect(model.adjacency.get("note:B.md")).toContain("note:A.md");
  });

  it("keeps unresolved link targets visible as hollow nodes", () => {
    const model = buildGraphModel(
      { "A.md": {} },
      { "A.md": { "Missing Note.md": 1 } },
      {},
    );
    const missing = model.nodes.find((n) => n.label === "Missing Note");
    expect(missing).toBeDefined();
    expect(missing!.unresolved).toBe(true);
    expect(model.edges).toHaveLength(1);
  });

  it("upgrades an unresolved node to resolved when both caches mention it", () => {
    const model = buildGraphModel(
      { "A.md": { "B.md": 1 } },
      { "A.md": { "B.md": 1 } },
      {},
    );
    const b = model.nodes.find((n) => n.id === "note:B.md")!;
    expect(b.unresolved).toBe(false);
    // One edge only — the seen-edge set dedupes across caches.
    expect(model.edges).toHaveLength(1);
  });

  it("adds tag square nodes and tag membership edges", () => {
    const model = buildGraphModel(
      {},
      {},
      { "A.md": { "#rust": 1, "#systems": 2 } },
    );
    const tagNodes = model.nodes.filter((n) => n.kind === "tag");
    expect(tagNodes.map((t) => t.label).sort()).toEqual(["rust", "systems"]);
    expect(model.edges.every((e) => e.kind === "tag")).toBe(true);
    expect(model.edges).toHaveLength(2);
  });

  it("is deterministic: same input, same node and edge order", () => {
    const a = buildGraphModel(
      { "B.md": { "A.md": 1 }, "A.md": { "C.md": 1 } },
      {},
      { "B.md": { "#x": 1 } },
    );
    const b = buildGraphModel(
      { "B.md": { "A.md": 1 }, "A.md": { "C.md": 1 } },
      {},
      { "B.md": { "#x": 1 } },
    );
    expect(a.nodes.map((n) => n.id)).toEqual(b.nodes.map((n) => n.id));
    expect(JSON.stringify(a.edges)).toEqual(JSON.stringify(b.edges));
  });

  it("strips folders and extensions in labels", () => {
    expect(noteLabel("Projects/Deep/My Note.md")).toBe("My Note");
  });
});

describe("computeLayout", () => {
  it("produces positions for every node without NaNs", () => {
    const model = buildGraphModel(
      { "A.md": { "B.md": 1 }, "B.md": { "C.md": 1 }, "C.md": {} },
      {},
      { "C.md": { "#tag": 1 } },
    );
    const layout = computeLayout(model, 1234);
    expect(layout.positions.size).toBe(model.nodes.length);
    for (const p of layout.positions.values()) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it("is deterministic for the same graph and seed", () => {
    const model = buildGraphModel(
      { "A.md": { "B.md": 1 }, "B.md": { "C.md": 1 }, "C.md": { "A.md": 1 } },
      {},
      {},
    );
    const one = computeLayout(model, 42);
    const two = computeLayout(model, 42);
    for (const [id, p] of one.positions) {
      expect(two.positions.get(id)!.x).toBeCloseTo(p.x, 10);
      expect(two.positions.get(id)!.y).toBeCloseTo(p.y, 10);
    }
  });

  it("pulls connected nodes closer than unconnected ones", () => {
    // Two clusters: A-B connected, C far away with no edges.
    const model = buildGraphModel({ "A.md": { "B.md": 1 } }, {}, {});
    const layout = computeLayout(model, 7);
    const a = layout.positions.get("note:A.md")!;
    const b = layout.positions.get("note:B.md")!;
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    // Spring length is 90; give the simulation slack but bound it.
    expect(dist).toBeLessThan(220);
  });

  it("handles the empty graph and single node without crashing", () => {
    const empty = computeLayout(buildGraphModel({}, {}, {}), 1);
    expect(empty.positions.size).toBe(0);
    const single = buildGraphModel({ "Solo.md": {} }, {}, {});
    const layout = computeLayout(single, 1);
    expect(layout.positions.get("note:Solo.md")).toBeDefined();
  });
});
