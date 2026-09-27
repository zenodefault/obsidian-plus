/**
 * SovereignGraphView — the left-sidebar knowledge graph (Workstream: graph
 * sidebar). A hand-rolled canvas renderer over the pure layout engine:
 * no new dependencies, deterministic layout, offline-safe.
 *
 * Interactions:
 * - wheel: zoom at cursor; drag background: pan; drag node: move it;
 * - hover: highlight the neighborhood, dim the rest;
 * - click a note: open it; click a tag: filter to it;
 * - filter box: substring match on note titles and tags.
 */

import { ItemView, WorkspaceLeaf } from "obsidian";
import type SovereignSecondBrainPlugin from "../main";
import { buildGraphModel, type GraphModel, type GraphNode } from "../components/graph/buildGraphModel";
import { computeLayout, type LayoutPoint } from "../components/graph/forceLayout";

export const VIEW_TYPE_SOVEREIGN_GRAPH = "sovereign-graph-view";

const NODE_RADIUS = 7;
const TAG_RADIUS = 5;
const HOVER_RADIUS = 14;

interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export class SovereignGraphView extends ItemView {
  private canvas!: HTMLCanvasElement;
  private statsEl!: HTMLElement;
  private filterEl!: HTMLInputElement;
  private model: GraphModel | null = null;
  private positions: Map<string, LayoutPoint> = new Map();
  private camera: Camera = { x: 0, y: 0, zoom: 1 };
  private hoverId: string | null = null;
  private draggedId: string | null = null;
  private panning = false;
  private lastPointer: { x: number; y: number } | null = null;
  private resizeObserver?: ResizeObserver;
  private manualPositions: Map<string, LayoutPoint> = new Map();
  private rafHandle: number | null = null;
  private disposed = false;

  constructor(leaf: WorkspaceLeaf, _plugin: SovereignSecondBrainPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_SOVEREIGN_GRAPH;
  }

  getDisplayText(): string {
    return "Sovereign graph";
  }

  getIcon(): string {
    return "git-fork";
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("sovereign-graph-root");

    // Header: stats + filter.
    const header = root.createDiv({ cls: "sovereign-graph-header" });
    this.statsEl = header.createDiv({ cls: "sovereign-graph-stats" });
    this.filterEl = header.createEl("input", {
      cls: "sovereign-graph-filter",
      attr: { type: "text", placeholder: "Filter…", spellcheck: "false" },
    });
    this.filterEl.addEventListener("input", () => this.requestRender());

    // Canvas body.
    const body = root.createDiv({ cls: "sovereign-graph-body" });
    this.canvas = body.createEl("canvas", { cls: "sovereign-graph-canvas" });
    this.attachCanvasEvents();

    this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
    this.resizeObserver.observe(body);
    this.resizeCanvas();

    this.rebuild();
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => this.rebuild()),
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", () => this.rebuild()),
    );
  }

  async onClose(): Promise<void> {
    this.disposed = true;
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.resizeObserver?.disconnect();
    this.canvas = null as unknown as HTMLCanvasElement;
  }

  // ---- model -------------------------------------------------------------

  private rebuild(): void {
    const cache = this.app.metadataCache;
    const resolved = (cache.resolvedLinks ?? {}) as Record<string, Record<string, number>>;
    const unresolved = (cache.unresolvedLinks ?? {}) as Record<
      string,
      Record<string, number>
    >;

    // Tag cache: per-file tag sets so edges are note → tag.
    const tags: Record<string, Record<string, number>> = {};
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fileTags = new Set<string>();
      const fmTags = this.app.metadataCache.getFileCache(file)?.frontmatter?.tags;
      const bodyTags = this.app.metadataCache.getFileCache(file)?.tags ?? [];
      for (const t of Array.isArray(fmTags) ? fmTags : fmTags ? [fmTags] : []) {
        fileTags.add(String(t).replace(/^#/, ""));
      }
      for (const t of bodyTags) fileTags.add(t.tag.replace(/^#/, ""));
      if (fileTags.size > 0) {
        const entry: Record<string, number> = {};
        for (const t of fileTags) entry[`#${t}`] = 1;
        tags[file.path] = entry;
      }
    }

    this.model = buildGraphModel(resolved, unresolved, tags);
    const layout = computeLayout(this.model, 0x9e3779b9);
    this.positions = layout.positions;
    this.manualPositions.clear();
    this.camera = { x: 0, y: 0, zoom: 1 };
    this.renderStats();
    this.requestRender();
  }

  private renderStats(): void {
    if (!this.model) return;
    const notes = this.model.nodes.filter((n) => n.kind === "note" && !n.unresolved).length;
    const unresolved = this.model.nodes.filter((n) => n.kind === "note" && n.unresolved).length;
    const tags = this.model.nodes.filter((n) => n.kind === "tag").length;
    this.statsEl.setText(
      `${notes} notes · ${tags} tags · ${unresolved} unresolved · ${this.model.edges.length} links`,
    );
  }

  // ---- canvas plumbing -----------------------------------------------------

  private resizeCanvas(): void {
    if (!this.canvas) return;
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.requestRender();
  }

  private requestRender(): void {
    if (this.rafHandle !== null || this.disposed) return;
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = null;
      this.draw();
    });
  }

  /** World → screen coordinates through the camera. */
  private toScreen(p: LayoutPoint): { x: number; y: number } {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;
    return {
      x: w / 2 + (p.x + this.camera.x) * this.camera.zoom,
      y: h / 2 + (p.y + this.camera.y) * this.camera.zoom,
    };
  }

  /** Screen → world coordinates (inverse camera). */
  private toWorld(sx: number, sy: number): { x: number; y: number } {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;
    return {
      x: (sx - w / 2) / this.camera.zoom - this.camera.x,
      y: (sy - h / 2) / this.camera.zoom - this.camera.y,
    };
  }

  private nodeAt(sx: number, sy: number): GraphNode | null {
    if (!this.model) return null;
    const pass = this.visibleNodes();
    for (let i = pass.length - 1; i >= 0; i--) {
      const node = pass[i];
      if (!node) continue;
      const pos = this.positions.get(node.id);
      if (!pos) continue;
      const s = this.toScreen(pos);
      const r = node.kind === "tag" ? TAG_RADIUS : NODE_RADIUS;
      const dx = sx - s.x;
      const dy = sy - s.y;
      if (dx * dx + dy * dy <= Math.max(HOVER_RADIUS, r * this.camera.zoom + 6) ** 2) {
        return node;
      }
    }
    return null;
  }

  /** Nodes passing the current filter. */
  private visibleNodes(): GraphNode[] {
    if (!this.model) return [];
    const query = this.filterEl?.value.trim().toLowerCase() ?? "";
    if (!query) return this.model.nodes;
    return this.model.nodes.filter(
      (n) => n.label.toLowerCase().contains(query),
    );
  }

  private neighborhood(id: string): Set<string> {
    const out = new Set<string>([id]);
    if (!this.model) return out;
    for (const neighbor of this.model.adjacency.get(id) ?? []) out.add(neighbor);
    return out;
  }

  // ---- drawing -----------------------------------------------------------

  private draw(): void {
    const ctx = this.canvas?.getContext("2d");
    if (!ctx || !this.model) return;
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const styles = getComputedStyle(this.canvas);
    const colorText = styles.getPropertyValue("--text-normal").trim() || "#ddd";
    const colorMuted = styles.getPropertyValue("--text-faint").trim() || "#777";
    const colorAccent = styles.getPropertyValue("--interactive-accent").trim() || "#7c3aed";
    const colorWarn = "#d97706";

    const focusSet = this.hoverId ? this.neighborhood(this.hoverId) : null;
    const visible = new Set(this.visibleNodes().map((n) => n.id));

    // Edges first (under nodes).
    for (const edge of this.model.edges) {
      if (!visible.has(edge.source) || !visible.has(edge.target)) continue;
      const a = this.positions.get(edge.source);
      const b = this.positions.get(edge.target);
      if (!a || !b) continue;
      const pa = this.toScreen(a);
      const pb = this.toScreen(b);
      const inFocus = !focusSet || (focusSet.has(edge.source) && focusSet.has(edge.target));
      ctx.globalAlpha = focusSet ? (inFocus ? 0.85 : 0.08) : edge.kind === "tag" ? 0.35 : 0.6;
      ctx.strokeStyle = edge.kind === "tag" ? colorMuted : colorAccent;
      ctx.lineWidth = edge.kind === "tag" ? 1 : 1.4;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }

    // Nodes.
    for (const node of this.visibleNodes()) {
      const pos = this.positions.get(node.id);
      if (!pos) continue;
      const s = this.toScreen(pos);
      const r = (node.kind === "tag" ? TAG_RADIUS : NODE_RADIUS) * this.camera.zoom;
      const inFocus = !focusSet || focusSet.has(node.id);
      ctx.globalAlpha = focusSet ? (inFocus ? 1 : 0.12) : 1;

      const radius = r;
      const label = node.label;

      if (node.kind === "tag") {
        // Square nodes for tags — distinct silhouette, no color guessing.
        ctx.fillStyle = colorMuted;
        ctx.strokeStyle = colorText;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(s.x - radius, s.y - radius, radius * 2, radius * 2);
        ctx.fill();
        ctx.stroke();
      } else {
        // Notes: filled circle; hollow when the link target doesn't exist.
        ctx.beginPath();
        ctx.arc(s.x, s.y, Math.max(2, radius), 0, Math.PI * 2);
        if (node.unresolved) {
          ctx.strokeStyle = colorWarn;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        } else {
          ctx.fillStyle = colorAccent;
          ctx.fill();
        }
      }

      // Labels only when zoomed in enough to be legible.
      if (this.camera.zoom > 0.55 && (inFocus || !focusSet)) {
        ctx.globalAlpha = focusSet ? (inFocus ? 0.95 : 0.05) : 0.75;
        ctx.fillStyle = colorText;
        ctx.font = `${node.kind === "tag" ? "italic " : ""}${Math.max(
          9,
          Math.round(10 * this.camera.zoom),
        )}px ${styles.getPropertyValue("--font-interface").trim() || "sans-serif"}`;
        ctx.textAlign = "center";
        ctx.fillText(label.slice(0, 28), s.x, s.y - radius - 4);
      }
    }

    ctx.restore();
  }

  // ---- interaction ---------------------------------------------------------

  private attachCanvasEvents(): void {
    const el = this.canvas;

    el.addEventListener("wheel", (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const before = this.toWorld(sx, sy);
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      this.camera.zoom = Math.min(4, Math.max(0.12, this.camera.zoom * factor));
      const after = this.toWorld(sx, sy);
      this.camera.x += after.x - before.x;
      this.camera.y += after.y - before.y;
      this.requestRender();
    });

    el.addEventListener("mousedown", (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const node = this.nodeAt(sx, sy);
      if (node) {
        this.draggedId = node.id;
      } else {
        this.panning = true;
      }
      this.lastPointer = { x: e.clientX, y: e.clientY };
    });

    el.addEventListener("mousemove", (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      if (this.draggedId) {
        const world = this.toWorld(sx, sy);
        this.manualPositions.set(this.draggedId, { x: world.x, y: world.y });
        this.positions.set(this.draggedId, { x: world.x, y: world.y });
        this.requestRender();
        return;
      }
      if (this.panning && this.lastPointer) {
        this.camera.x += (e.clientX - this.lastPointer.x) / this.camera.zoom;
        this.camera.y += (e.clientY - this.lastPointer.y) / this.camera.zoom;
        this.lastPointer = { x: e.clientX, y: e.clientY };
        this.requestRender();
        return;
      }

      // Hover highlight.
      const node = this.nodeAt(sx, sy);
      const next = node ? node.id : null;
      if (next !== this.hoverId) {
        this.hoverId = next;
        el.style.cursor = node ? "pointer" : "grab";
        this.requestRender();
      }
    });

    window.addEventListener("mouseup", (e: MouseEvent) => {
      if (this.draggedId && this.lastPointer) {
        const moved =
          Math.abs(e.clientX - this.lastPointer.x) + Math.abs(e.clientY - this.lastPointer.y);
        if (moved < 4) {
          // Treat as a click: open notes, filter by tags.
          const node = this.model?.nodes.find((n) => n.id === this.draggedId);
          if (node?.kind === "note" && !node.unresolved) {
            void this.app.workspace.openLinkText(node.label, "", false);
          } else if (node?.kind === "tag") {
            this.filterEl.value = node.label;
            this.requestRender();
          }
        }
        this.draggedId = null;
      }
      this.panning = false;
      this.lastPointer = null;
    });
  }
}
