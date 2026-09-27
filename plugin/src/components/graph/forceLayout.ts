/**
 * Force-directed layout (Workstream: graph sidebar). Pure, seeded,
 * deterministic — same input, same output, no Math.random. Grid-accelerated
 * repulsion keeps large vaults responsive on the render thread.
 *
 * The simulation runs a bounded number of iterations up front (no per-frame
 * physics in the view), so the canvas just paints coordinates.
 */

import type { GraphModel, GraphNode } from "./buildGraphModel";

export interface LayoutPoint {
  x: number;
  y: number;
}

export interface LayoutResult {
  positions: Map<string, LayoutPoint>; // node id → point
}

/** Simulated-annealing-ish constants. Tuned for ~50–2000 node vaults. */
const REPULSION = 2400;
const SPRING_LENGTH = 90;
const SPRING_STRENGTH = 0.04;
const DAMPING = 0.85;
const ITERATIONS = 220;
const CANVAS_RADIUS = 420; // layout space is a square of ±CANVAS_RADIUS

/** Deterministic 32-bit RNG (mulberry32). */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable per-node seed so a given graph always lays out identically. */
function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Compute the layout. `seed` perturbs the initial placement; passing the
 * same seed for the same graph yields identical coordinates.
 */
export function computeLayout(model: GraphModel, seed = 0x9e3779b9): LayoutResult {
  const rng = makeRng(seed ^ 0x85ebca6b);
  const nodes = model.nodes;
  const positions = new Map<string, LayoutPoint>();

  // Initial placement: deterministic ring with jitter, tags nearer center.
  nodes.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / Math.max(1, nodes.length);
    const radius = node.kind === "tag" ? CANVAS_RADIUS * 0.35 : CANVAS_RADIUS * 0.7;
    positions.set(node.id, {
      x: Math.cos(angle) * radius + (rng() - 0.5) * 40,
      y: Math.sin(angle) * radius + (rng() - 0.5) * 40,
    });
  });

  const velocities = new Map<string, LayoutPoint>();
  for (const node of nodes) velocities.set(node.id, { x: 0, y: 0 });

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const forces = new Map<string, LayoutPoint>();
    for (const node of nodes) forces.set(node.id, { x: 0, y: 0 });

    // Repulsion: grid-accelerated. One node per cell, cell size = typical
    // spring length; only neighbors in 3×3 cells feel the full force.
    const cell = SPRING_LENGTH * 2;
    const grid = new Map<string, GraphNode[]>();
    for (const node of nodes) {
      const p = positions.get(node.id)!;
      const key = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(node);
      else grid.set(key, [node]);
    }

    for (const node of nodes) {
      const p = positions.get(node.id)!;
      const gx = Math.floor(p.x / cell);
      const gy = Math.floor(p.y / cell);
      const force = forces.get(node.id)!;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const bucket = grid.get(`${gx + dx},${gy + dy}`);
          if (!bucket) continue;
          for (const other of bucket) {
            if (other.id === node.id) continue;
            const q = positions.get(other.id)!;
            applyRepulsion(node, p, q, force);
          }
        }
      }
    }

    // Springs along edges (tag edges slightly looser).
    for (const edge of model.edges) {
      const a = positions.get(edge.source);
      const b = positions.get(edge.target);
      if (!a || !b) continue;
      const length = edge.kind === "tag" ? SPRING_LENGTH * 1.35 : SPRING_LENGTH;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.0001;
      // Stronger pull when far apart (bounded), so small sparse graphs still
      // converge to the spring length instead of drifting apart.
      const displacement =
        SPRING_STRENGTH * (dist - length) * Math.min(3, 1 + dist / (length * 2));
      const fx = (dx / dist) * displacement;
      const fy = (dy / dist) * displacement;
      const fa = forces.get(edge.source)!;
      const fb = forces.get(edge.target)!;
      fa.x += fx;
      fa.y += fy;
      fb.x -= fx;
      fb.y -= fy;
    }

    // Integrate with damping; forces shrink over iterations so the layout
    // settles instead of oscillating forever.
    const cooling = 1 - iter / ITERATIONS;
    for (const node of nodes) {
      const force = forces.get(node.id)!;
      const vel = velocities.get(node.id)!;
      vel.x = (vel.x + force.x * 0.02) * DAMPING;
      vel.y = (vel.y + force.y * 0.02) * DAMPING;
      const p = positions.get(node.id)!;
      p.x += vel.x * cooling;
      p.y += vel.y * cooling;
    }
  }

  // Center the result around the origin.
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

function applyRepulsion(
  node: GraphNode,
  p: LayoutPoint,
  q: LayoutPoint,
  force: LayoutPoint,
): void {
  let dx = p.x - q.x;
  let dy = p.y - q.y;
  let distSq = dx * dx + dy * dy;
  if (distSq < 0.01) {
    // Coincident points: nudge apart deterministically by id hash.
    const nudge = (hashString(node.id) % 7) - 3 || 1;
    dx = nudge * 0.37;
    dy = -nudge * 0.21;
    distSq = dx * dx + dy * dy;
  }
  const dist = Math.sqrt(distSq);
  const strength = REPULSION / (distSq * dist + 0.01);
  force.x += dx * strength * 0.01;
  force.y += dy * strength * 0.01;
}
