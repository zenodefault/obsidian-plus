/**
 * Graph renderer (Workstream: graph redesign). A pure canvas painter over the
 * deterministic layout: no DOM, no Obsidian imports, no internal state. The
 * view owns interaction and animation timing; this module turns
 * (model, positions, camera, theme, visual state) into pixels.
 *
 * Visual language (restrained, theme-aware):
 * - notes: circles scaled by real degree; unresolved links are hollow dashed
 *   rings (a visible gap in the vault, never decoration);
 * - tags: distinct diamonds, smaller and quieter;
 * - selection: halo + ring; the neighborhood stays lit, the rest fades;
 * - search: matches stay lit, everything else fades;
 * - labels appear by zoom tier, so zoomed-out views read as regions.
 */

import type { GraphModel, GraphNode } from "./buildGraphModel";
import { MIN_REGION_SIZE, type GraphCluster } from "./clusters";
import type { LayoutPoint } from "./forceLayout";

/** Pan/zoom state in world coordinates (x/y = world offset at screen center). */
export interface GraphCamera {
  x: number;
  y: number;
  zoom: number;
}

export const CAMERA_ZOOM_MIN = 0.05;
export const CAMERA_ZOOM_MAX = 6;

/** Theme colors resolved by the view from Obsidian CSS variables. */
export interface GraphTheme {
  /** Normal node fill (accent). */
  accent: string;
  /** Softer accent for halos and hover rings. */
  accentSoft: string;
  text: string;
  muted: string;
  faint: string;
  border: string;
  /** Hollow/unresolved ring color. */
  warning: string;
  /** Tag fill (quiet neutral). */
  tagFill: string;
  font: string;
}

/** Everything the renderer needs to know about the current interaction. */
export interface GraphVisualState {
  selectedId: string | null;
  hoverId: string | null;
  /** Non-null while a search is active: ids that match the query. */
  searchMatches: Set<string> | null;
  /** True while an entrance animation is still playing (0..1). */
  entranceProgress: number;
}

export interface RenderInput {
  ctx: CanvasRenderingContext2D;
  model: GraphModel;
  /** Animated display positions (may lag the layout during transitions). */
  positions: Map<string, LayoutPoint>;
  camera: GraphCamera;
  viewport: { width: number; height: number };
  dpr: number;
  theme: GraphTheme;
  state: GraphVisualState;
  /**
   * Real connected groups (from `findClusters`). Optional: without them the
   * renderer simply paints the flat graph.
   */
  clusters?: GraphCluster[];
}

// ---- pure helpers (unit-tested) -------------------------------------------

/** Real connection count for a node — the only honest size signal. */
export function nodeDegree(model: GraphModel, id: string): number {
  return model.adjacency.get(id)?.length ?? 0;
}

/**
 * Effective node radius in world units. Notes grow gently with degree
 * (diminishing returns, capped); tags stay small and quiet.
 */
export function effectiveRadius(model: GraphModel, node: GraphNode): number {
  const base = node.kind === "tag" ? 5 : 6.5;
  if (node.kind !== "note") return base;
  const degree = nodeDegree(model, node.id);
  // sqrt growth: degree 1 → ×1.12, 10 → ×2.1, 30 → ×2.9 (capped ×3.1)
  const scale = 1 + Math.min(Math.sqrt(degree) * 0.36, 2.1);
  return base * scale;
}

/** Cubic ease for camera/node transitions. */
export function easeInOutCubic(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Emphasis of a single node: 1 = fully lit, lower = faded. */
export function emphasisFor(
  model: GraphModel,
  nodeId: string,
  state: GraphVisualState,
): number {
  if (state.searchMatches) {
    if (state.searchMatches.has(nodeId)) return 1;
    // The selected node stays visible during search too.
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

/** Edge emphasis: lit when either endpoint is in the focus neighborhood. */
export function edgeEmphasis(
  model: GraphModel,
  source: string,
  target: string,
  state: GraphVisualState,
): number {
  const a = emphasisFor(model, source, state);
  const b = emphasisFor(model, target, state);
  return Math.min(a, b);
}

/** Camera that frames the given points with padding, zoom-clamped. */
export function fitCameraToPoints(
  points: LayoutPoint[],
  viewport: { width: number; height: number },
  opts: { minZoom?: number; maxZoom?: number; padding?: number } = {},
): GraphCamera {
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
    Math.max(minZoom, Math.min(viewport.width / (bw + padding * 2), viewport.height / (bh + padding * 2))),
  );
  return {
    x: -(minX + maxX) / 2,
    y: -(minY + maxY) / 2,
    zoom,
  };
}

/** World → screen through the camera (CSS pixels). */
export function worldToScreen(
  p: LayoutPoint,
  camera: GraphCamera,
  viewport: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: viewport.width / 2 + (p.x + camera.x) * camera.zoom,
    y: viewport.height / 2 + (p.y + camera.y) * camera.zoom,
  };
}

/** Screen → world (inverse camera). */
export function screenToWorld(
  sx: number,
  sy: number,
  camera: GraphCamera,
  viewport: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: (sx - viewport.width / 2) / camera.zoom - camera.x,
    y: (sy - viewport.height / 2) / camera.zoom - camera.y,
  };
}

/** How many characters of label to draw at a given zoom (readability tier). */
export function labelCharBudget(zoom: number, emphasized: boolean): number {
  if (emphasized && zoom >= 0.35) return 44;
  if (zoom >= 1.1) return 44;
  if (zoom >= 0.7) return 28;
  if (zoom >= 0.45) return 18;
  return 0; // too far out: regions, not titles
}

/**
 * Zoom hierarchy for individual note labels:
 * - far out: nothing (the regions carry the map);
 * - medium: the important notes — real degree, not decoration;
 * - close: every note.
 * Hovered/selected/search-emphasized nodes always label once readable.
 */
export function shouldLabelNode(zoom: number, emphasized: boolean, degree: number): boolean {
  if (emphasized) return zoom >= 0.3;
  if (zoom >= 1.15) return true;
  if (zoom >= 0.7) return degree >= 3;
  return false;
}

/**
 * Zoom hierarchy for cluster (region) labels: the opposite of note labels —
 * they belong to the wide view and get out of the way up close.
 */
export function shouldLabelRegion(zoom: number, size: number): boolean {
  if (size < MIN_REGION_SIZE) return false;
  if (zoom >= 1.15) return false;
  if (zoom >= 0.5) return size >= 8;
  return true;
}

// ---- rendering -------------------------------------------------------------

/** Paint one full frame. Reads only from `input`; mutates nothing. */
export function renderGraph(input: RenderInput): void {
  const { ctx, model, positions, camera, viewport, dpr, theme, state } = input;
  const w = viewport.width;
  const h = viewport.height;

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const entrance = state.entranceProgress;

  // Pass 0: knowledge regions (real connected groups), behind everything.
  // Deliberately faint: they hint at structure without becoming decorative
  // blobs, and they scale with the group's own emphasis during focus/search.
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
      if (
        center.x < -radius ||
        center.x > w + radius ||
        center.y < -radius ||
        center.y > h + radius
      ) {
        continue;
      }

      const fade = 1 - Math.min(1, camera.zoom / 1.2);
      const alpha = 0.055 * emphasis * fade;
      if (alpha > 0.004) {
        const gradient = ctx.createRadialGradient(
          center.x,
          center.y,
          radius * 0.15,
          center.x,
          center.y,
          radius,
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

  // Pass 1: edges (under everything).
  for (const edge of model.edges) {
    const a = positions.get(edge.source);
    const b = positions.get(edge.target);
    if (!a || !b) continue;
    const emphasis = edgeEmphasis(model, edge.source, edge.target, state) * entrance;
    if (emphasis <= 0.02) continue;
    const pa = worldToScreen(a, camera, viewport);
    const pb = worldToScreen(b, camera, viewport);
    // Cull edges fully outside the viewport.
    if (
      (pa.x < -40 && pb.x < -40) ||
      (pa.x > w + 40 && pb.x > w + 40) ||
      (pa.y < -40 && pb.y < -40) ||
      (pa.y > h + 40 && pb.y > h + 40)
    ) {
      continue;
    }
    const isTag = edge.kind === "tag";
    const isConnectedToSelection =
      state.selectedId !== null && (edge.source === state.selectedId || edge.target === state.selectedId);
    const lit = emphasis >= 0.99;
    ctx.globalAlpha = isTag ? emphasis * 0.32 : emphasis * (lit ? 0.55 : 0.4);
    ctx.strokeStyle = isConnectedToSelection && lit ? theme.accent : theme.faint;
    ctx.lineWidth = isTag ? 0.75 : isConnectedToSelection && lit ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }

  // Pass 2: nodes (draw dim ones first so lit nodes sit on top).
  const drawOrder: Array<{ node: GraphNode; pos: LayoutPoint; emphasis: number }> = [];
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

    // Cull offscreen nodes (with label headroom).
    if (s.x < -60 || s.x > w + 60 || s.y < -60 || s.y > h + 60) continue;

    ctx.globalAlpha = emphasis * entrance;
    if (emphasis <= 0.02) continue;

    // Selected node: quiet halo under the dot.
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
      // Diamonds: a different silhouette, rotated 45°, quiet fill.
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
      // Unresolved: hollow dashed ring — a visible gap in the vault.
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

    // Labels: tiered by zoom; emphasized nodes label earlier.
    const emphasized = emphasis >= 0.99 || isSelected || isHover;
    const degree = nodeDegree(model, node.id);
    const budget = shouldLabelNode(camera.zoom, emphasized, degree)
      ? labelCharBudget(camera.zoom, emphasized)
      : 0;
    if (budget > 0) {
      const label = node.label;
      if (label.length > 0) {
        const fontSize = node.kind === "tag" ? 10 : 11.5;
        ctx.font = `${node.kind === "tag" ? "italic " : "500 "}${fontSize}px ${theme.font}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const shown =
          label.length > budget ? `${label.slice(0, Math.max(1, budget - 1))}…` : label;
        const ly = s.y - r - fontSize * 0.85;
        // Soft backing so labels survive busy backgrounds in both themes.
        ctx.globalAlpha = emphasis * entrance * (isSelected ? 0.95 : 0.82);
        ctx.fillStyle = isSelected ? theme.text : theme.muted;
        ctx.strokeStyle = withAlpha(theme.text, 0.0); // reserved
        ctx.fillText(shown, s.x, ly);
      }
    }
  }

  ctx.restore();
  ctx.globalAlpha = 1;
}

/** #rrggbb → rgba() with the given alpha; passes through rgba()/named colors. */
export function withAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  const hex = color.trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  if (short) {
    const r = parseInt(short[1]! + short[1]!, 16);
    const g = parseInt(short[2]! + short[2]!, 16);
    const b = parseInt(short[3]! + short[3]!, 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (long) {
    return `rgba(${parseInt(long[1]!, 16)}, ${parseInt(long[2]!, 16)}, ${parseInt(long[3]!, 16)}, ${a})`;
  }
  // Obsidian's theme variables often resolve to `rgb(r, g, b)`; gradients need
  // a real alpha stop, otherwise the outer stop would be opaque too.
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(hex);
  if (rgb) {
    return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${a})`;
  }
  // Already alpha-capable or unknown: rely on globalAlpha instead.
  return hex;
}
