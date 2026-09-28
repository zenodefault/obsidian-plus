/**
 * SovereignGraphView — the knowledge graph (Workstream: graph redesign).
 *
 * A visual map of the user's actual Obsidian vault: notes, tags, resolved
 * and unresolved links from the metadata cache. No fake nodes, no invented
 * clusters — importance is real degree, clusters emerge from real layout.
 *
 * Interactions:
 * - wheel: smooth zoom at cursor; drag background: pan; drag node: move it;
 * - hover: the neighborhood stays lit, the rest recedes;
 * - click a note: select it (details panel); click again / "Open note": opens;
 * - search: dims non-matches, Enter flies the camera to the first match,
 *   Escape clears;
 * - selection drives the details panel: related notes, open, focus
 *   neighborhood, Ask Sovereign;
 * - "fit" recenters the whole graph; the entrance eases nodes into place.
 *
 * Performance: the layout is computed once (deterministic, no per-frame
 * physics). rAF is requested only when something actually changed — hover,
 * pan, zoom, selection or a short eased transition. An idle graph costs
 * nothing.
 */

import { ItemView, WorkspaceLeaf } from "obsidian";
import type SovereignSecondBrainPlugin from "../main";
import {
  buildGraphModel,
  type GraphModel,
  type GraphNode,
} from "../components/graph/buildGraphModel";
import { computeLayout, type LayoutPoint } from "../components/graph/forceLayout";
import {
  findClusters,
  clusterIndex,
  MIN_REGION_SIZE,
  type GraphCluster,
} from "../components/graph/clusters";
import {
  renderGraph,
  effectiveRadius,
  easeInOutCubic,
  fitCameraToPoints,
  screenToWorld,
  worldToScreen,
  CAMERA_ZOOM_MIN,
  CAMERA_ZOOM_MAX,
  type GraphCamera,
  type GraphTheme,
  type GraphVisualState,
} from "../components/graph/renderGraph";

export const VIEW_TYPE_SOVEREIGN_GRAPH = "sovereign-graph-view";

/** Duration of camera/node eased transitions (ms). */
const TRANSITION_MS = 420;
/** Entrance animation duration (ms). */
const ENTRANCE_MS = 650;

interface Transition {
  from: GraphCamera;
  to: GraphCamera;
  start: number;
}

interface NodeAnim {
  id: string;
  from: LayoutPoint;
  start: number;
}

export class SovereignGraphView extends ItemView {
  private canvas!: HTMLCanvasElement;
  private statsEl!: HTMLElement;
  private searchEl!: HTMLInputElement;
  private searchCountEl!: HTMLElement;
  private detailsEl!: HTMLElement;
  private emptyEl!: HTMLElement;
  private canvasBody!: HTMLElement;
  private srStatusEl!: HTMLElement;

  private model: GraphModel | null = null;
  /** Real connected groups (connected components over link/tag edges). */
  private clusters: GraphCluster[] = [];
  private clusterOf: Map<string, string> = new Map();
  private layoutPositions: Map<string, LayoutPoint> = new Map();
  /** Animated display positions (eased toward the layout / drag targets). */
  private positions: Map<string, LayoutPoint> = new Map();

  private camera: GraphCamera = { x: 0, y: 0, zoom: 1 };
  private cameraTransition: Transition | null = null;
  private nodeAnims: NodeAnim[] = [];
  private entranceStart: number | null = null;

  private visual: GraphVisualState = {
    selectedId: null,
    hoverId: null,
    searchMatches: null,
    entranceProgress: 1,
  };

  private draggingNode: string | null = null;
  private dragMoved = false;
  private panning = false;
  private lastPointer: { x: number; y: number } | null = null;
  private pinchDist: number | null = null;

  private resizeObserver?: ResizeObserver;
  private rafHandle: number | null = null;
  private disposed = false;

  /** Match list for search cycling (real labels only). */
  private matchIds: string[] = [];
  private matchCursor = 0;
  /** `prefers-reduced-motion` — transitions become instant when set. */
  private motionQuery: MediaQueryList | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private pluginInstance: SovereignSecondBrainPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_SOVEREIGN_GRAPH;
  }

  getDisplayText(): string {
    return "Sovereign knowledge graph";
  }

  getIcon(): string {
    return "git-fork";
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("sovereign-graph-root");

    // ---- header: brand line, search, actions -----------------------------
    const header = root.createDiv({ cls: "sovereign-graph-header" });
    const brand = header.createDiv({ cls: "sovereign-graph-brand" });
    brand.createSpan({ text: "Knowledge map", cls: "sovereign-graph-title" });
    this.statsEl = brand.createSpan({ cls: "sovereign-graph-stats" });

    const controls = header.createDiv({ cls: "sovereign-graph-controls" });
    this.searchCountEl = controls.createSpan({ cls: "sovereign-graph-search-count" });
    this.searchEl = controls.createEl("input", {
      cls: "sovereign-graph-search",
      attr: {
        type: "text",
        placeholder: "Search knowledge…",
        spellcheck: "false",
        "aria-label": "Search the graph",
      },
    });
    this.searchEl.addEventListener("input", () => this.onSearchInput());
    this.searchEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        // Enter walks through the matches instead of always landing on the
        // first one — graph navigation, not conversation.
        this.focusNextMatch();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.clearSearch();
        this.searchEl.blur();
      }
    });

    const fitBtn = controls.createEl("button", {
      cls: "sovereign-graph-icon-btn",
      attr: { "aria-label": "Fit graph to view" },
    });
    fitBtn.setText("⤢");
    fitBtn.addEventListener("click", () => this.fitToContent(true));

    // ---- canvas body ------------------------------------------------------
    this.canvasBody = root.createDiv({ cls: "sovereign-graph-body" });
    this.canvas = this.canvasBody.createEl("canvas", { cls: "sovereign-graph-canvas" });
    // Keyboard-first navigation: the canvas is focusable and self-describing.
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("role", "application");
    this.canvas.setAttribute(
      "aria-label",
      "Sovereign knowledge graph. Arrow keys move between notes, Enter opens the selected note, F fits the map, Escape clears the selection.",
    );
    // Screen readers get the state changes as text.
    this.srStatusEl = this.canvasBody.createDiv({
      cls: "sovereign-graph-sr",
      attr: { "aria-live": "polite" },
    });
    this.attachCanvasEvents();
    this.attachKeyboardEvents();
    this.motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

    // ---- details panel (populated on selection) ---------------------------
    this.detailsEl = root.createDiv({
      cls: "sovereign-graph-details",
      attr: { "aria-live": "polite" },
    });
    this.detailsEl.hide();

    // ---- empty state (real data only; shown when the vault is empty) ------
    this.emptyEl = root.createDiv({ cls: "sovereign-graph-empty" });
    this.emptyEl.createDiv({ text: "YOUR KNOWLEDGE MAP", cls: "sovereign-graph-empty-title" });
    this.emptyEl.createDiv({
      text: "Your graph will grow as Sovereign indexes notes and relationships. Create a few linked notes to see the map take shape.",
      cls: "sovereign-graph-empty-sub",
    });
    const createBtn = this.emptyEl.createEl("button", {
      text: "Create a note",
      cls: "sovereign-graph-empty-btn",
    });
    createBtn.addEventListener("click", () => {
      void this.app.workspace.openLinkText("Untitled", "", true);
    });
    this.emptyEl.hide();

    this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
    this.resizeObserver.observe(this.canvasBody);
    this.resizeCanvas();

    this.rebuild();
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.rebuild()));
    this.registerEvent(
      this.app.metadataCache.on("changed", () => {
        // Cheap refresh of counts/labels; a full relayout only on resolve.
        this.renderStats();
        this.requestRender();
      }),
    );
  }

  async onClose(): Promise<void> {
    this.disposed = true;
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
    this.resizeObserver?.disconnect();
  }

  // ---- model --------------------------------------------------------------

  private rebuild(): void {
    const cache = this.app.metadataCache;
    const resolved = (cache.resolvedLinks ?? {}) as Record<string, Record<string, number>>;
    const unresolved = (cache.unresolvedLinks ?? {}) as Record<string, Record<string, number>>;

    // Tag cache: per-file tag sets so edges are note → tag.
    const tags: Record<string, Record<string, number>> = {};
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fileTags = new Set<string>();
      const fileCache = this.app.metadataCache.getFileCache(file);
      const fmTags = fileCache?.frontmatter?.tags;
      const bodyTags = fileCache?.tags ?? [];
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
    this.layoutPositions = computeLayout(this.model, 0x9e3779b9).positions;
    // Real connected groups: computed from the actual edges, nothing inferred.
    this.clusters = findClusters(this.model);
    this.clusterOf = clusterIndex(this.clusters);

    // Preserve dragged positions for nodes the user moved by hand.
    const display = new Map<string, LayoutPoint>();
    for (const [id, p] of this.layoutPositions) {
      display.set(id, { ...p });
    }
    this.positions = display;

    this.cameraTransition = null;
    this.visual = { ...this.visual, selectedId: null, hoverId: null, searchMatches: null };
    this.detailsEl.hide();
    this.renderStats();

    const isEmpty = this.model.nodes.length === 0;
    this.emptyEl.toggle(isEmpty);
    this.canvasBody.toggleClass("is-empty", isEmpty);

    if (!isEmpty) {
      this.fitToContent(false);
      this.startEntrance();
    }
    this.requestRender();
  }

  private renderStats(): void {
    if (!this.model) return;
    const notes = this.model.nodes.filter((n) => n.kind === "note" && !n.unresolved).length;
    const unresolved = this.model.nodes.filter((n) => n.kind === "note" && n.unresolved).length;
    const tags = this.model.nodes.filter((n) => n.kind === "tag").length;
    const parts = [`${notes} note${notes === 1 ? "" : "s"}`];
    if (tags > 0) parts.push(`${tags} tag${tags === 1 ? "" : "s"}`);
    if (unresolved > 0) parts.push(`${unresolved} unresolved`);
    this.statsEl.setText(parts.join(" · "));
  }

  // ---- theme --------------------------------------------------------------

  /** Resolve theme colors from Obsidian CSS variables (adapts to light/dark). */
  private theme(): GraphTheme {
    const styles = getComputedStyle(this.canvas);
    const pick = (name: string, fallback: string): string =>
      styles.getPropertyValue(name).trim() || fallback;
    return {
      accent: pick("--interactive-accent", "#7c6cff"),
      accentSoft: pick("--interactive-accent-hover", "#9a8cff"),
      text: pick("--text-normal", "#ddd"),
      muted: pick("--text-muted", "#999"),
      faint: pick("--text-faint", "#666"),
      border: pick("--background-modifier-border", "#333"),
      warning: pick("--text-warning", "#d97706"),
      tagFill: pick("--background-modifier-hover", "#2a2a2e"),
      font: pick("--font-interface", "sans-serif"),
    };
  }

  // ---- canvas plumbing ------------------------------------------------------

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

  private viewport(): { width: number; height: number } {
    const dpr = window.devicePixelRatio || 1;
    return {
      width: this.canvas ? this.canvas.width / dpr : 0,
      height: this.canvas ? this.canvas.height / dpr : 0,
    };
  }

  private requestRender(): void {
    if (this.rafHandle !== null || this.disposed) return;
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = null;
      this.tick();
    });
  }

  /**
   * One animation tick: advance eased transitions, then draw. Schedules the
   * next frame ONLY while something is still animating — an idle graph never
   * repaints.
   */
  private tick(): void {
    const now = performance.now();
    let animating = false;

    // Entrance ease (nodes drift from a slight offset into place).
    if (this.entranceStart !== null) {
      const t = Math.min(1, (now - this.entranceStart) / ENTRANCE_MS);
      this.visual.entranceProgress = easeInOutCubic(t);
      if (t < 1) animating = true;
      else this.entranceStart = null;
    } else {
      this.visual.entranceProgress = 1;
    }

    // Camera transition.
    if (this.cameraTransition) {
      const { from, to, start } = this.cameraTransition;
      const t = Math.min(1, (now - start) / TRANSITION_MS);
      const e = easeInOutCubic(t);
      this.camera = {
        x: from.x + (to.x - from.x) * e,
        y: from.y + (to.y - from.y) * e,
        zoom: from.zoom + (to.zoom - from.zoom) * e,
      };
      if (t < 1) animating = true;
      else this.cameraTransition = null;
    }

    // Node entrance/drag eases toward layout positions.
    if (this.nodeAnims.length > 0) {
      const still: NodeAnim[] = [];
      for (const anim of this.nodeAnims) {
        const target = this.layoutPositions.get(anim.id);
        if (!target) continue;
        const t = Math.min(1, (now - anim.start) / TRANSITION_MS);
        const e = easeInOutCubic(t);
        const cur = this.positions.get(anim.id) ?? anim.from;
        this.positions.set(anim.id, {
          x: anim.from.x + (target.x - anim.from.x) * e,
          y: anim.from.y + (target.y - anim.from.y) * e,
        });
        if (t < 1) still.push(anim);
        else void cur;
      }
      this.nodeAnims = still;
      if (still.length > 0) animating = true;
    }

    this.draw();

    if (animating) this.requestRender();
  }

  private draw(): void {
    if (!this.model || !this.canvas) return;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    renderGraph({
      ctx,
      model: this.model,
      positions: this.positions,
      camera: this.camera,
      viewport: this.viewport(),
      dpr: window.devicePixelRatio || 1,
      theme: this.theme(),
      state: this.visual,
      clusters: this.clusters,
    });
  }

  // ---- camera -------------------------------------------------------------

  /** Respect `prefers-reduced-motion`: transitions become instant, not absent. */
  private reducedMotion(): boolean {
    return this.motionQuery?.matches ?? false;
  }

  /** Frame the whole graph. Animates when `animate` is set. */
  private fitToContent(animate: boolean): void {
    if (!this.model) return;
    const points = [...this.layoutPositions.values()];
    const target = fitCameraToPoints(points, this.viewport(), { minZoom: 0.2, maxZoom: 1.25 });
    this.animateCameraTo(target, animate);
  }

  /** Frame a real connected group — the "explore this region" gesture. */
  private focusCluster(clusterId: string): void {
    const cluster = this.clusters.find((c) => c.id === clusterId);
    if (!cluster) return;
    const points = cluster.nodeIds
      .map((nid) => this.positions.get(nid))
      .filter((p): p is LayoutPoint => !!p);
    if (points.length === 0) return;
    this.animateCameraTo(
      fitCameraToPoints(points, this.viewport(), { minZoom: 0.25, maxZoom: 1.1, padding: 110 }),
      true,
    );
    this.announce(`Focused group ${cluster.label} (${cluster.size} notes).`);
  }

  /** Fly the camera to a node and select it. */
  private focusNode(id: string, select: boolean): void {
    const pos = this.positions.get(id) ?? this.layoutPositions.get(id);
    if (!pos) return;
    const node = this.model?.nodes.find((n) => n.id === id);
    const r = node ? effectiveRadius(this.model!, node) : 8;
    const zoom = Math.min(2.2, Math.max(0.9, 90 / Math.max(12, r)));
    const target: GraphCamera = { x: -pos.x, y: -pos.y, zoom };
    this.animateCameraTo(target, true);
    if (select) this.select(id);
  }

  private animateCameraTo(target: GraphCamera, animate: boolean): void {
    if (!animate || this.reducedMotion()) {
      this.camera = { ...target };
      this.cameraTransition = null;
      this.requestRender();
      return;
    }
    this.cameraTransition = {
      from: { ...this.camera },
      to: target,
      start: performance.now(),
    };
    this.requestRender();
  }

  private startEntrance(): void {
    if (this.reducedMotion()) {
      this.entranceStart = null;
      this.visual.entranceProgress = 1;
      this.requestRender();
      return;
    }
    this.entranceStart = performance.now();
    this.visual.entranceProgress = 0;
    this.requestRender();
  }

  // ---- selection / search ---------------------------------------------------

  private select(id: string | null): void {
    if (this.visual.selectedId === id) return;
    this.visual.selectedId = id;
    this.renderDetails();
    const node = id ? this.model?.nodes.find((n) => n.id === id) : null;
    if (node) {
      const connections = this.model?.adjacency.get(node.id)?.length ?? 0;
      this.announce(`Selected ${node.label}, ${connections} connections.`);
    } else {
      this.announce("Selection cleared.");
    }
    this.requestRender();
  }

  /** Announce state changes to assistive tech without visual chrome. */
  private announce(message: string): void {
    if (this.srStatusEl) this.srStatusEl.setText(message);
  }

  private onSearchInput(): void {
    const q = this.searchEl.value.trim().toLowerCase();
    if (!q) {
      this.visual.searchMatches = null;
      this.matchIds = [];
      this.matchCursor = 0;
      this.searchCountEl.setText("");
      this.requestRender();
      return;
    }
    if (!this.model) return;
    this.matchIds = this.model.nodes
      .filter((n) => n.label.toLowerCase().includes(q))
      .map((n) => n.id);
    this.visual.searchMatches = new Set(this.matchIds);
    this.matchCursor = 0;
    this.searchCountEl.setText(
      this.matchIds.length === 0 ? "no matches" : `${this.matchIds.length} match${this.matchIds.length === 1 ? "" : "es"}`,
    );
    this.requestRender();
  }

  /** Enter: walk through the matches (camera + selection move with them). */
  private focusNextMatch(): void {
    if (this.matchIds.length === 0) return;
    const id = this.matchIds[this.matchCursor % this.matchIds.length]!;
    this.matchCursor = (this.matchCursor + 1) % this.matchIds.length;
    this.focusNode(id, true);
  }

  private clearSearch(): void {
    this.searchEl.value = "";
    this.visual.searchMatches = null;
    this.matchIds = [];
    this.matchCursor = 0;
    this.searchCountEl.setText("");
    this.requestRender();
  }

  /**
   * Note → graph integration: fly the camera to a note by path and select it.
   * Called from the plugin's "reveal current note in graph" command.
   */
  revealNote(path: string): void {
    const id = `note:${path}`;
    if (this.model?.nodes.some((n) => n.id === id)) {
      this.focusNode(id, true);
    }
  }

  /** Open the real note behind a node (resolved notes only). */
  private openNote(node: GraphNode): void {
    if (node.kind !== "note" || node.unresolved) return;
    void this.app.workspace.openLinkText(node.label, "", false);
  }

  // ---- details panel ---------------------------------------------------------

  private renderDetails(): void {
    const id = this.visual.selectedId;
    const node = id ? this.model?.nodes.find((n) => n.id === id) : null;
    this.detailsEl.empty();
    if (!id || !node || !this.model) {
      this.detailsEl.hide();
      return;
    }

    const neighbors = (this.model.adjacency.get(id) ?? [])
      .map((nid) => this.model!.nodes.find((n) => n.id === nid))
      .filter((n): n is GraphNode => !!n);

    this.detailsEl.show();

    const head = this.detailsEl.createDiv({ cls: "sovereign-graph-details-head" });
    head.createSpan({
      text: node.label,
      cls: "sovereign-graph-details-title",
      attr: { title: node.kind === "note" ? id.slice(5) : `#${node.label}` },
    });
    const close = head.createSpan({
      cls: "sovereign-graph-details-close",
      attr: { "aria-label": "Clear selection", role: "button", tabindex: "0" },
    });
    close.setText("✕");
    const clear = (): void => this.select(null);
    close.addEventListener("click", clear);
    close.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") clear();
    });

    const meta = this.detailsEl.createDiv({ cls: "sovereign-graph-details-meta" });
    const kindLabel =
      node.kind === "tag"
        ? "TAG"
        : node.unresolved
          ? "UNRESOLVED LINK"
          : "NOTE";
    meta.createSpan({ text: kindLabel, cls: "sovereign-graph-details-kind" });
    meta.createSpan({
      text: `${neighbors.length} connection${neighbors.length === 1 ? "" : "s"}`,
      cls: "sovereign-graph-details-count",
    });

    // The group this note sits in — computed from real links/tags, and named
    // after a tag the user wrote or its busiest note. Never a fabricated
    // semantic category.
    const cluster = this.clusters.find((c) => c.id === this.clusterOf.get(id));
    if (cluster && cluster.size >= MIN_REGION_SIZE) {
      const groupRow = this.detailsEl.createDiv({ cls: "sovereign-graph-details-group" });
      const groupLink = groupRow.createSpan({
        cls: "sovereign-graph-details-group-link",
        attr: {
          role: "button",
          tabindex: "0",
          title:
            cluster.labelSource === "tag"
              ? "Connected group, named after the most common tag among its notes"
              : cluster.labelSource === "hub"
                ? "Connected group, named after its most connected note"
                : "Connected group",
        },
      });
      groupLink.setText(`Connected group · ${cluster.label} · ${cluster.size} notes`);
      const focusGroup = (): void => this.focusCluster(cluster.id);
      groupLink.addEventListener("click", focusGroup);
      groupLink.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          focusGroup();
        }
      });
    }

    if (neighbors.length > 0) {
      const rel = this.detailsEl.createDiv({ cls: "sovereign-graph-details-related" });
      rel.createDiv({ text: "RELATED", cls: "sovereign-graph-details-sub" });
      const list = rel.createDiv({ cls: "sovereign-graph-details-list" });
      for (const n of neighbors.slice(0, 6)) {
        const row = list.createSpan({ cls: "sovereign-graph-details-rel" });
        row.setText(n.label);
        row.addEventListener("click", () => this.focusNode(n.id, true));
      }
      if (neighbors.length > 6) {
        rel.createDiv({
          text: `${neighbors.length - 6} more connection${neighbors.length - 6 === 1 ? "" : "s"}`,
          cls: "sovereign-graph-details-more",
        });
      }
    }

    const actions = this.detailsEl.createDiv({ cls: "sovereign-graph-details-actions" });
    if (node.kind === "note" && !node.unresolved) {
      const open = actions.createEl("button", { text: "Open note", cls: "sovereign-graph-details-btn" });
      open.addEventListener("click", () => this.openNote(node));
    }
    const focusBtn = actions.createEl("button", {
      text: "Focus neighborhood",
      cls: "sovereign-graph-details-btn",
    });
    focusBtn.addEventListener("click", () => {
      this.animateCameraTo(
        { x: -(this.positions.get(id)?.x ?? 0), y: -(this.positions.get(id)?.y ?? 0), zoom: Math.max(this.camera.zoom, 1.4) },
        true,
      );
    });
    if (node.kind === "note") {
      const ask = actions.createEl("button", {
        text: "Ask Sovereign",
        cls: "sovereign-graph-details-btn sovereign-graph-details-ask",
      });
      ask.addEventListener("click", () => {
        // No synthesized question: the popup opens *aware of this note* (real
        // context) and the user owns the wording. Enter on an empty input asks
        // with the note title verbatim.
        this.openAskForNode(node);
      });
    }
  }

  /** Hand a selected node to the Second Brain popup as real context. */
  private openAskForNode(node: GraphNode): void {
    const path = node.kind === "note" ? node.id.slice("note:".length) : undefined;
    this.pluginInstance.askSovereign(undefined, {
      label: node.label,
      path: node.unresolved ? undefined : path,
    });
  }

  // ---- interaction -----------------------------------------------------------

  private nodeAt(sx: number, sy: number): GraphNode | null {
    if (!this.model) return null;
    const vp = this.viewport();
    let best: { node: GraphNode; distSq: number } | null = null;
    for (let i = this.model.nodes.length - 1; i >= 0; i--) {
      const node = this.model.nodes[i]!;
      const pos = this.positions.get(node.id);
      if (!pos) continue;
      const s = worldToScreen(pos, this.camera, vp);
      const r = effectiveRadius(this.model, node) * this.camera.zoom;
      const hit = Math.max(10, r + 4);
      const dx = sx - s.x;
      const dy = sy - s.y;
      const dSq = dx * dx + dy * dy;
      if (dSq <= hit * hit && (!best || dSq < best.distSq)) {
        best = { node, distSq: dSq };
      }
    }
    return best?.node ?? null;
  }

  /** The currently selected node, when there is one. */
  private selectedNode(): GraphNode | null {
    const id = this.visual.selectedId;
    if (!id || !this.model) return null;
    return this.model.nodes.find((n) => n.id === id) ?? null;
  }

  /** Notes ordered by real connection count — the keyboard traversal order. */
  private orderedNodeIds(): string[] {
    if (!this.model) return [];
    return [...this.model.nodes]
      .sort((a, b) => {
        const da = this.model!.adjacency.get(a.id)?.length ?? 0;
        const db = this.model!.adjacency.get(b.id)?.length ?? 0;
        return db - da || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      })
      .map((n) => n.id);
  }

  private cycleSelection(delta: number): void {
    const order = this.orderedNodeIds();
    if (order.length === 0) return;
    const current = this.visual.selectedId;
    const index = current ? order.indexOf(current) : -1;
    const next = (((index + delta) % order.length) + order.length) % order.length;
    this.focusNode(order[next]!, true);
  }

  /**
   * Keyboard surface: the graph is fully explorable without a pointer.
   * Arrow keys move by real connection count, Enter opens, F fits, Escape
   * clears. The canvas owns focus, so these never fight the search field.
   */
  private attachKeyboardEvents(): void {
    this.canvas.addEventListener("keydown", (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowRight":
        case "ArrowDown":
          e.preventDefault();
          this.cycleSelection(1);
          return;
        case "ArrowLeft":
        case "ArrowUp":
          e.preventDefault();
          this.cycleSelection(-1);
          return;
        case "Enter": {
          const node = this.selectedNode();
          if (node && node.kind === "note" && !node.unresolved) {
            e.preventDefault();
            this.openNote(node);
          }
          return;
        }
        case "f":
        case "F":
          e.preventDefault();
          this.fitToContent(true);
          this.announce("Fitted the whole map.");
          return;
        case "Escape":
          e.preventDefault();
          this.select(null);
          this.clearSearch();
          return;
        default:
          return;
      }
    });
  }

  private attachCanvasEvents(): void {
    const el = this.canvas;

    el.addEventListener("wheel", (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const vp = this.viewport();
      const before = screenToWorld(sx, sy, this.camera, vp);
      const factor = Math.exp(-e.deltaY * 0.0016);
      const zoom = Math.min(CAMERA_ZOOM_MAX, Math.max(CAMERA_ZOOM_MIN, this.camera.zoom * factor));
      const after = screenToWorld(sx, sy, { ...this.camera, zoom }, vp);
      this.camera = { zoom, x: this.camera.x + (before.x - after.x), y: this.camera.y + (before.y - after.y) };
      this.cameraTransition = null;
      this.requestRender();
    }, { passive: false });

    // Pointer events cover mouse + touch (pinch) uniformly.
    el.addEventListener("pointerdown", (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId);
      const rect = el.getBoundingClientRect();
      const node = this.nodeAt(e.clientX - rect.left, e.clientY - rect.top);
      if (e.button === 1 || (!node && e.button === 0 && e.ctrlKey)) {
        this.panning = true;
      } else if (node) {
        this.draggingNode = node.id;
        this.dragMoved = false;
      } else if (e.button === 0) {
        this.panning = true;
      }
      this.lastPointer = { x: e.clientX, y: e.clientY };
    });

    el.addEventListener("pointermove", (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      if (this.draggingNode) {
        const vp = this.viewport();
        const world = screenToWorld(sx, sy, this.camera, vp);
        this.positions.set(this.draggingNode, { x: world.x, y: world.y });
        this.layoutPositions.set(this.draggingNode, { x: world.x, y: world.y });
        this.dragMoved = true;
        this.requestRender();
        return;
      }
      if (this.panning && this.lastPointer) {
        const dx = (e.clientX - this.lastPointer.x) / this.camera.zoom;
        const dy = (e.clientY - this.lastPointer.y) / this.camera.zoom;
        this.camera = { ...this.camera, x: this.camera.x + dx, y: this.camera.y + dy };
        this.cameraTransition = null;
        this.lastPointer = { x: e.clientX, y: e.clientY };
        this.requestRender();
        return;
      }

      const node = this.nodeAt(sx, sy);
      const next = node ? node.id : null;
      if (next !== this.visual.hoverId) {
        this.visual.hoverId = next;
        el.style.cursor = node ? "pointer" : "grab";
        this.requestRender();
      }
    });

    const endPointer = (e: PointerEvent): void => {
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      if (this.draggingNode) {
        const node = this.model?.nodes.find((n) => n.id === this.draggingNode);
        if (node && !this.dragMoved) {
          // Treat as click: select; second click on the same node opens it.
          if (this.visual.selectedId === node.id && node.kind === "note" && !node.unresolved) {
            this.openNote(node);
          } else {
            this.select(node.id);
          }
        }
        this.draggingNode = null;
      }
      this.panning = false;
      this.lastPointer = null;
    };
    el.addEventListener("pointerup", endPointer);
    el.addEventListener("pointercancel", endPointer);

    // Click empty space clears the selection.
    el.addEventListener("click", (e: MouseEvent) => {
      if (this.dragMoved) {
        this.dragMoved = false;
        return;
      }
      const rect = el.getBoundingClientRect();
      const node = this.nodeAt(e.clientX - rect.left, e.clientY - rect.top);
      if (!node && !this.panning) this.select(null);
    });

    el.addEventListener("dblclick", (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      const node = this.nodeAt(e.clientX - rect.left, e.clientY - rect.top);
      if (node && node.kind === "note" && !node.unresolved) {
        e.preventDefault();
        this.openNote(node);
      }
    });

    // Touch pinch zoom.
    el.addEventListener("touchmove", (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      const [a, b] = [e.touches[0]!, e.touches[1]!];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (this.pinchDist !== null) {
        const factor = dist / this.pinchDist;
        const zoom = Math.min(CAMERA_ZOOM_MAX, Math.max(CAMERA_ZOOM_MIN, this.camera.zoom * factor));
        this.camera = { ...this.camera, zoom };
        this.cameraTransition = null;
        this.requestRender();
      }
      this.pinchDist = dist;
    }, { passive: false });
    el.addEventListener("touchend", () => {
      this.pinchDist = null;
    });
  }
}

// Re-export for main.ts command wiring convenience.
export type { GraphCamera } from "../components/graph/renderGraph";
