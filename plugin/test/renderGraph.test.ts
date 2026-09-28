/**
 * Graph renderer tests: the pure paint/geometry helpers stay honest —
 * emphasis math (focus neighborhood, search dimming), zoom-tier labels,
 * camera fitting and color alpha handling.
 */

import { describe, expect, it } from "vitest";
import { buildGraphModel } from "../src/components/graph/buildGraphModel";
import {
  emphasisFor,
  edgeEmphasis,
  effectiveRadius,
  labelCharBudget,
  fitCameraToPoints,
  withAlpha,
  worldToScreen,
  screenToWorld,
  type GraphVisualState,
} from "../src/components/graph/renderGraph";

const IDLE: GraphVisualState = {
  selectedId: null,
  hoverId: null,
  searchMatches: null,
  entranceProgress: 1,
};

describe("emphasisFor", () => {
  const model = buildGraphModel(
    { "A.md": { "B.md": 1 }, "B.md": { "C.md": 1 } },
    {},
    {},
  );

  it("keeps everything lit when nothing is selected", () => {
    for (const n of model.nodes) {
      expect(emphasisFor(model, n.id, IDLE)).toBe(1);
    }
  });

  it("focuses the selected node and its direct neighbors, fades the rest", () => {
    const state: GraphVisualState = { ...IDLE, selectedId: "note:B.md" };
    expect(emphasisFor(model, "note:B.md", state)).toBe(1);
    expect(emphasisFor(model, "note:A.md", state)).toBe(1);
    expect(emphasisFor(model, "note:C.md", state)).toBe(1);
  });

  it("fades unreachable nodes during selection", () => {
    const model2 = buildGraphModel(
      { "A.md": { "B.md": 1 } },
      { "X.md": { "Y.md": 1 } },
      {},
    );
    const state: GraphVisualState = { ...IDLE, selectedId: "note:A.md" };
    expect(emphasisFor(model2, "note:A.md", state)).toBe(1);
    expect(emphasisFor(model2, "note:B.md", state)).toBe(1);
    expect(emphasisFor(model2, "note:Y.md", state)).toBeLessThan(0.5);
  });

  it("dims non-matches during search but keeps matches lit", () => {
    const state: GraphVisualState = {
      ...IDLE,
      searchMatches: new Set(["note:A.md"]),
    };
    expect(emphasisFor(model, "note:A.md", state)).toBe(1);
    expect(emphasisFor(model, "note:C.md", state)).toBeLessThan(0.2);
  });
});

describe("edgeEmphasis", () => {
  it("is lit when both endpoints are in the neighborhood, dim otherwise", () => {
    const model = buildGraphModel(
      { "A.md": { "B.md": 1 }, "C.md": { "D.md": 1 } },
      {},
      {},
    );
    const state: GraphVisualState = { ...IDLE, selectedId: "note:A.md" };
    expect(edgeEmphasis(model, "note:A.md", "note:B.md", state)).toBe(1);
    expect(edgeEmphasis(model, "note:C.md", "note:D.md", state)).toBeLessThan(0.2);
  });
});

describe("effectiveRadius", () => {
  it("grows with real degree and keeps tags small", () => {
    // Hub with three links vs a leaf with one.
    const model = buildGraphModel(
      { "Hub.md": { "A.md": 1, "B.md": 1, "C.md": 1 }, "A.md": {} },
      {},
      {},
    );
    const hub = model.nodes.find((n) => n.id === "note:Hub.md")!;
    const leaf = model.nodes.find((n) => n.id === "note:A.md")!;
    expect(effectiveRadius(model, hub)).toBeGreaterThan(effectiveRadius(model, leaf));

    const tagModel = buildGraphModel({}, {}, { "A.md": { "#x": 1 } });
    const tag = tagModel.nodes.find((n) => n.kind === "tag")!;
    expect(effectiveRadius(tagModel, tag)).toBeLessThan(effectiveRadius(model, leaf));
  });
});

describe("labelCharBudget", () => {
  it("hides labels zoomed out, shows short labels mid-zoom, full labels close up", () => {
    expect(labelCharBudget(0.2, true)).toBe(0);
    expect(labelCharBudget(0.5, false)).toBe(18);
    expect(labelCharBudget(0.8, false)).toBe(28);
    expect(labelCharBudget(1.5, false)).toBe(44);
  });
});

describe("fitCameraToPoints", () => {
  it("frames a cloud of points with the viewport", () => {
    const cam = fitCameraToPoints(
      [
        { x: -100, y: -50 },
        { x: 100, y: 50 },
      ],
      { width: 800, height: 600 },
    );
    expect(cam.zoom).toBeGreaterThan(0);
    // Center of the cloud lands at the screen center.
    const center = worldToScreen({ x: 0, y: 0 }, cam, { width: 800, height: 600 });
    expect(center.x).toBeCloseTo(400, 5);
    expect(center.y).toBeCloseTo(300, 5);
  });

  it("returns the identity camera for no points", () => {
    const cam = fitCameraToPoints([], { width: 800, height: 600 });
    expect(cam).toEqual({ x: 0, y: 0, zoom: 1 });
  });
});

describe("withAlpha", () => {
  it("expands hex colors to rgba", () => {
    expect(withAlpha("#ff0000", 0.5)).toBe("rgba(255, 0, 0, 0.5)");
    expect(withAlpha("#f00", 1)).toBe("rgba(255, 0, 0, 1)");
    expect(withAlpha("#6d5ef0", 0)).toBe("rgba(109, 94, 240, 0)");
  });

  it("passes non-hex colors through", () => {
    expect(withAlpha("rgba(1,2,3,0.5)", 0.5)).toBe("rgba(1,2,3,0.5)");
  });
});

describe("camera round-trip", () => {
  it("screen→world→screen is the identity", () => {
    const cam = { x: 12, y: -30, zoom: 1.7 };
    const vp = { width: 640, height: 480 };
    const world = { x: 55, y: -70 };
    const screen = worldToScreen(world, cam, vp);
    const back = screenToWorld(screen.x, screen.y, cam, vp);
    expect(back.x).toBeCloseTo(world.x, 8);
    expect(back.y).toBeCloseTo(world.y, 8);
  });
});
