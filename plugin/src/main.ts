/**
 * Sovereign Second Brain — Obsidian plugin entry point.
 *
 * Deliberately thin (PLAN.md §4.1): lifecycle wiring only. All intelligence
 * lives in the core process.
 *
 * UI surfaces (Workstream: overlay + graph + setup):
 * - `SovereignOverlayModal` — hotkey popup: a focused Ask surface for the
 *   second brain (question → thinking → answer → sources; no tabs).
 * - `SovereignGraphView` — left-sidebar knowledge map of the real vault.
 * - `SetupWizardModal` — first-run onboarding.
 */

import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import * as os from "node:os";
import * as path from "node:path";
import { SovereignDaemon, type DaemonStatus } from "./services/daemon";
import {
  resolveCoreBinaryDetailed,
  type BinaryResolution,
} from "./services/daemon/spawn";
import { DEFAULT_SETTINGS, SovereignBrainSettings } from "./settings/settings";
import { buildInventory, readNote } from "./vault/inventory";
import { runSync, SyncAbortedError } from "./vault/sync";
import { createVaultWatcher } from "./vault/attach";
import { SovereignBrainSettingTab } from "./settings/SettingTab";
import {
  openSovereignOverlay,
  type OverlayContext,
} from "./views/SovereignOverlayModal";
import type { RelatedNote } from "./components/AskViewComponent";
import type { BeamOptions } from "./ui/beam";
import {
  SovereignGraphView,
  VIEW_TYPE_SOVEREIGN_GRAPH,
} from "./views/SovereignGraphView";
import { SovereignPanelView, VIEW_TYPE_SOVEREIGN_PANEL } from "./views/SovereignPanelView";
import { SetupWizardModal } from "./onboarding/SetupWizardModal";
import {
  RealBrainDataService,
  daemonClient,
} from "./services/brainDataService";
import {
  autoLinkCheck,
  OLLAMA_WATCH_INTERVAL_MS,
} from "./services/ollama";
export default class SovereignSecondBrainPlugin extends Plugin {
  settings: SovereignBrainSettings = { ...DEFAULT_SETTINGS };
  private daemon: SovereignDaemon | null = null;
  private brain: RealBrainDataService | null = null;
  private syncInFlight: Promise<void> | null = null;
  private syncQueued = false;
  private ollamaWatchTimer?: number;
  private ollamaWatchInFlight = false;
  /**
   * Boot gating for the core: `onload` never blocks Obsidian startup, so all
   * core-dependent actions must wait on this. It resolves (never rejects) once
   * the first `startDaemon()` attempt has settled — success or honest failure.
   */
  private bootPromise: Promise<void> | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Knowledge graph leaf (left sidebar, own ribbon icon).
    this.registerView(
      VIEW_TYPE_SOVEREIGN_GRAPH,
      (leaf: WorkspaceLeaf) => new SovereignGraphView(leaf, this),
    );
    this.registerView(
      VIEW_TYPE_SOVEREIGN_PANEL,
      (leaf: WorkspaceLeaf) => new SovereignPanelView(leaf, this),
    );

    // Ribbon: brain icon → hotkey overlay.
    this.addRibbonIcon("brain", "Sovereign Brain (overlay)", () => {
      this.openOverlay();
    });

    this.addRibbonIcon("panel-left", "Open Sovereign panel", () => {
      void this.activateSovereignPanel();
    });

    // Ribbon: fork icon → knowledge graph in the left sidebar.
    this.addRibbonIcon("git-fork", "Sovereign knowledge graph", () => {
      void this.activateGraphView();
    });

    // Hotkey-openable overlay (default Ctrl/Cmd+Shift+B; rebindable).
    this.addCommand({
      id: "open-sovereign-overlay",
      name: "Open Sovereign Brain",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "b" }],
      callback: () => {
        this.openOverlay();
      },
    });

    this.addCommand({
      id: "restart-sovereign-core",
      name: "Restart core",
      callback: () => {
        void this.restartCore();
      },
    });

    this.addCommand({
      id: "open-sovereign-graph",
      name: "Open knowledge graph",
      callback: () => {
        void this.activateGraphView();
      },
    });
    this.addCommand({
      id: "open-sovereign-panel",
      name: "Open Sovereign panel",
      callback: () => void this.activateSovereignPanel(),
    });

    this.addCommand({
      id: "reveal-note-in-sovereign-graph",
      name: "Reveal current note in knowledge graph",
      callback: () => {
        void this.revealNoteInGraph();
      },
    });

    // Note → graph, from the file explorer / tab context menu.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        menu.addItem((item) =>
          item
            .setTitle("Show in Sovereign knowledge graph")
            .setIcon("git-fork")
            .onClick(() => void this.revealNoteInGraph(file.path)),
        );
      }),
    );

    this.addCommand({
      id: "run-sovereign-setup",
      name: "Run setup wizard",
      callback: () => {
        new SetupWizardModal(this.app, this).open();
      },
    });

    // Settings Tab
    this.addSettingTab(new SovereignBrainSettingTab(this.app, this));

    // Never block Obsidian startup on the core (PLAN.md §91). Every
    // core-dependent action below waits on the settled boot attempt instead.
    this.bootPromise = this.startDaemon()
      .catch(() => undefined)
      .then(() => undefined);

    // First-run: open the setup wizard once, after the workspace settles.
    if (!this.settings.onboardingComplete) {
      this.app.workspace.onLayoutReady(() => {
        new SetupWizardModal(this.app, this).open();
      });
    }
  }

  /**
   * RELATED notes for an answer: other notes that are actually linked to or
   * from the answer's sources, straight from Obsidian's link cache. Real links
   * only, ranked by how many of the sources touch them, capped at four.
   */
  relatedNotesFor(sourcePaths: string[]): RelatedNote[] {
    if (sourcePaths.length === 0) return [];
    const resolved = (this.app.metadataCache.resolvedLinks ?? {}) as Record<
      string,
      Record<string, number>
    >;

    // Reverse index once per call, so this stays linear in vault edges.
    const incoming = new Map<string, string[]>();
    for (const [from, targets] of Object.entries(resolved)) {
      for (const target of Object.keys(targets)) {
        const bucket = incoming.get(target);
        if (bucket) bucket.push(from);
        else incoming.set(target, [from]);
      }
    }

    const cited = new Set(sourcePaths);
    const counts = new Map<string, number>();
    const consider = (path: string): void => {
      if (!path.endsWith(".md") || cited.has(path)) return;
      counts.set(path, (counts.get(path) ?? 0) + 1);
    };
    for (const path of sourcePaths) {
      for (const target of Object.keys(resolved[path] ?? {})) consider(target);
      for (const from of incoming.get(path) ?? []) consider(from);
    }

    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 4)
      .map(([path]) => ({
        path,
        title: (path.split("/").pop() ?? path).replace(/\.md$/i, ""),
      }));
  }

  /** BorderBeam configuration for the popup, from settings. */
  private beamOptions(): BeamOptions {
    return {
      size: this.settings.beamSize,
      color: this.settings.beamColor,
      strength: this.settings.beamStrength,
      active: true,
    };
  }

  /**
   * Where the user actually is: the active note plus any selected text. This
   * is real editor state (never inferred), handed to the overlay so a question
   * asked from inside a note is answered in that note's context.
   */
  currentNoteContext(): OverlayContext | undefined {
    const file = this.app.workspace.getActiveFile();
    if (!file) return undefined;
    const editor = this.app.workspace.activeEditor?.editor;
    const selected = editor?.getSelection().trim();
    return {
      label: file.basename,
      path: file.path,
      selectedText: selected && selected.length > 0 ? selected : undefined,
    };
  }

  /** Open the overlay popup with the current services and editor context. */
  private openOverlay(): void {
    openSovereignOverlay(
      this.app,
      {
        brain: this.brainData(),
        beam: this.beamOptions(),
        related: (paths) => this.relatedNotesFor(paths),
      },
      { context: this.currentNoteContext() },
    );
  }

  /**
   * Programmatic ask (graph → "Ask Sovereign"). The query is passed verbatim —
   * callers own the wording; nothing is synthesized here. `context` is the real
   * knowledge the user selected in the graph.
   */
  askSovereign(query?: string, context?: OverlayContext): void {
    openSovereignOverlay(
      this.app,
      {
        brain: this.brainData(),
        beam: this.beamOptions(),
        related: (paths) => this.relatedNotesFor(paths),
      },
      { query, context: context ?? this.currentNoteContext() },
    );
  }

  /** Reveal (or create) the knowledge graph leaf in the left sidebar. */
  async openKnowledgeMap(): Promise<void> {
    await this.activateGraphView();
  }

  private async activateSovereignPanel(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_SOVEREIGN_PANEL)[0];
    if (existing) {
      workspace.revealLeaf(existing);
      return;
    }
    const leaf = workspace.getLeftLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE_SOVEREIGN_PANEL, active: true });
      workspace.revealLeaf(leaf);
    }
  }

  private async activateGraphView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_SOVEREIGN_GRAPH)[0];
    if (existing) {
      workspace.revealLeaf(existing);
      return;
    }
    const leftLeaf = workspace.getLeftLeaf(false);
    if (leftLeaf) {
      await leftLeaf.setViewState({
        type: VIEW_TYPE_SOVEREIGN_GRAPH,
        active: true,
      });
      workspace.revealLeaf(leftLeaf);
    }
  }

  /**
   * Note → graph integration: open (or reveal) the knowledge map and fly the
   * camera to a note. Defaults to the command palette's active file.
   */
  async revealNoteInGraph(path?: string): Promise<void> {
    const target = path ?? this.app.workspace.getActiveFile()?.path;
    await this.activateGraphView();
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_SOVEREIGN_GRAPH)[0];
    const view = leaf?.view;
    if (view instanceof SovereignGraphView && target) {
      view.revealNote(target);
    }
  }

  onunload(): void {
    if (this.ollamaWatchTimer !== undefined) {
      window.clearInterval(this.ollamaWatchTimer);
      this.ollamaWatchTimer = undefined;
    }
    const daemon = this.daemon;
    this.daemon = null;
    if (daemon) void daemon.stop();
  }

  /** Access for later workstreams (views, commands) — not for UI styling. */
  getDaemon(): SovereignDaemon | null {
    return this.daemon;
  }

  /** Lazily start the daemon if it isn't running (wizard re-entry path). */
  async ensureDaemon(): Promise<void> {
    if (this.bootPromise) await this.bootPromise;
    if (this.daemon && this.daemon.getStatus() === "running") return;
    await this.startDaemon();
  }

  /**
   * A fresh client closure bound to the current daemon. Used by surfaces
   * that need raw protocol access (settings model status, wizard).
   */
  getClientFactory(): () => ReturnType<typeof daemonClient> | null {
    return () => (this.daemon ? daemonClient(this.daemon) : null);
  }

  /** Services wired to the live daemon; null-client closures when offline. */
  brainData(): RealBrainDataService {
    this.brain =
      this.brain ?? new RealBrainDataService(() => (this.daemon ? daemonClient(this.daemon) : null));
    return this.brain;
  }

  /** Trigger an incremental sync (coalesced if one is already running). */
  syncNow(): Promise<void> {
    if (this.syncInFlight) {
      this.syncQueued = true;
      return this.syncInFlight;
    }
    this.syncInFlight = this.performSync(false)
      .catch((err) => {
        if (!(err instanceof SyncAbortedError)) {
          console.error("[sovereign] sync failed:", err);
        }
      })
      .finally(() => {
        this.syncInFlight = null;
        if (this.syncQueued) {
          this.syncQueued = false;
          void this.syncNow();
        }
      });
    return this.syncInFlight;
  }

  private async performSync(rebuild: boolean): Promise<void> {
    const daemon = this.daemon;
    if (!daemon) return;

    const outcome = await runSync(
      {
        begin: (rebuild) => daemon.request("vault.sync.begin", { rebuild }),
        batch: (sid, notes) =>
          daemon.request("vault.sync.batch", { session_id: sid, notes }),
        commit: (sid) => daemon.request("vault.sync.commit", { session_id: sid }),
        readNote: (p) => readNote(this.app.vault, p),
        uploadNote: (sid, note) => daemon.request("vault.sync.note", { session_id: sid, ...note }),
        finish: (sid) => daemon.request("vault.sync.finish", { session_id: sid }),
      },
      await buildInventory(this.app.vault),
      {
        rebuild,
        shouldAbort: () => this.daemon === null,
      },
    );

    console.info(
      `[sovereign] synced: +${outcome.added.length} ~${outcome.modified.length} ` +
        `→${outcome.renamed.length} -${outcome.deleted.length} ` +
        `(total ${outcome.totalNotes})`,
    );
  }

  /**
   * Obsidian's `manifest.dir` is a **vault-relative** path. Anything that
   * touches the filesystem (the core binary) must resolve it against the
   * vault root first — otherwise every candidate is probed relative to
   * Obsidian's own working directory, never matches, and the plugin reports
   * "the Sovereign core is not running" even though the binary is right there.
   */
  pluginDirPath(): string {
    const dir = this.manifest.dir ?? "";
    if (dir && path.isAbsolute(dir)) return dir;
    const root = this.vaultRoot();
    if (root) {
      return dir ? path.join(root, dir) : path.join(root, ".obsidian", "plugins", this.manifest.id);
    }
    return path.resolve(dir);
  }

  /** Absolute vault root on desktop; null when the adapter cannot report one. */
  vaultRoot(): string | null {
    const adapter = this.app.vault.adapter as unknown as {
      getBasePath?: () => string;
      getFullPath?: (p: string) => string;
    };
    try {
      if (typeof adapter.getBasePath === "function") return adapter.getBasePath();
    } catch {
      // Non-desktop or instrumented adapter: fall through.
    }
    return null;
  }

  /** Where the core binary was found (or the search space that failed). */
  resolveCore(): BinaryResolution {
    const configured = this.settings.coreBinaryPath.trim();
    if (configured) return { path: configured, searched: [configured] };
    return resolveCoreBinaryDetailed({
      pluginDir: this.pluginDirPath(),
      vaultRoot: this.vaultRoot(),
    });
  }

  /** Core process status for diagnostics surfaces (settings tab). */
  coreStatus(): DaemonStatus {
    return this.daemon?.getStatus() ?? "stopped";
  }

  /**
   * Start (or report why the core could not start). Returns a one-line
   * diagnostic so commands/settings can surface the real reason instead of a
   * generic "offline" state.
   */
  async startDaemon(): Promise<string> {
    const resolution = this.resolveCore();
    const binaryPath = resolution.path;

    if (!binaryPath) {
      console.warn(
        "[sovereign] core binary not found. Searched:\n  " + resolution.searched.join("\n  "),
      );
      const detail =
        `Sovereign core binary not found (${resolution.searched.length} locations searched). ` +
        "Run ./scripts/install.sh — it copies sovereign-core next to the plugin — or set the " +
        "core binary path in Sovereign settings. Your notes were not modified.";
      new Notice(detail, 12_000);
      return detail;
    }

    const dataDir = this.settings.dataDir || path.join(os.homedir(), "SovereignBrain");

    this.daemon = new SovereignDaemon({
      binaryPath,
      dataDir,
      requestTimeoutMs: this.settings.requestTimeoutMs,
      onLog: (line) => console.debug("[sovereign-core]", line),
      onUnexpectedExit: (code, signal) => {
        console.warn(`[sovereign] core exited unexpectedly (code=${code} signal=${signal})`);
      },
    });

    try {
      const health = await this.daemon.start();
      console.info(
        `[sovereign] core running v${health.version} (protocol v${health.protocol_version}, pid ${health.pid}) ` +
          `from ${binaryPath}`,
      );
      this.attachVaultEvents();
      // Initial sync in the background (§91: startup never waits).
      void this.syncNow();
      // Local LLM auto-link: probe Ollama once the core is healthy, then
      // keep watching on a slow cadence (links servers started later).
      this.startOllamaWatcher();
      return `Sovereign core running (v${health.version}).`;
    } catch (err) {
      console.error("[sovereign] core failed to start:", err);
      const reason = err instanceof Error ? err.message : String(err);
      const detail = `Sovereign core failed to start: ${reason} Your notes were not modified.`;
      new Notice(detail, 12_000);
      // Vault is untouched; the core can be restarted later.
      return detail;
    }
  }

  /**
   * Stop and start the core on demand — the recovery path when the core died,
   * the binary moved, or settings changed. Never throws.
   */
  async restartCore(): Promise<string> {
    const previous = this.daemon;
    this.daemon = null;
    if (previous) {
      try {
        await previous.stop();
      } catch (err) {
        console.debug("[sovereign] core stop during restart:", err);
      }
    }
    const detail = await this.startDaemon();
    new Notice(detail, 8_000);
    return detail;
  }

  private attachVaultEvents(): void {
    const { watcher } = createVaultWatcher(this.app.vault, {
      scheduleSync: () => void this.syncNow(),
    });
    const events = ["create", "modify", "delete", "rename"] as const;
    for (const event of events) {
      // Obsidian's per-event overloads don't accept a union name; the watcher
      // signature is compatible with all four, so one cast covers them.
      this.registerEvent(this.app.vault.on(event as "modify", watcher));
    }
  }

  /**
   * Slow-cadence Ollama watcher: links a local Ollama automatically when it
   * is running now, or when it starts later. One shot per link: a Notice
   * plus a full re-embed, exactly once per establishment.
   */
  /** Restart the watcher after a settings change (no-op when disabled or offline). */
  restartOllamaWatcher(): void {
    if (this.ollamaWatchTimer !== undefined) {
      window.clearInterval(this.ollamaWatchTimer);
      this.ollamaWatchTimer = undefined;
    }
    if (this.settings.ollamaAutoLink && this.daemon?.getStatus() === "running") {
      this.startOllamaWatcher();
    }
  }

  private startOllamaWatcher(): void {
    if (!this.settings.ollamaAutoLink) return;
    if (this.ollamaWatchTimer !== undefined) return;

    const check = async (): Promise<void> => {
      if (this.ollamaWatchInFlight) return;
      this.ollamaWatchInFlight = true;
      try {
        const daemon = this.daemon;
        if (!daemon || daemon.getStatus() !== "running") return;
        const client = daemonClient(daemon);
        const status = await client.request<{ provider?: string }>("models.status", {});
        const linked = await autoLinkCheck(status.provider, {
          dataDir: this.settings.dataDir || path.join(os.homedir(), "SovereignBrain"),
          request: <T,>(method: string, params: unknown) =>
            client.request<T>(method, params),
        });
        if (linked) {
          new Notice(linked.message, 8_000);
          // Only an embedding-provider change invalidates vectors; a
          // generation-only link leaves every existing embedding untouched.
          if (linked.embedLinked !== false) {
            await this.performSync(true);
          }
        }
      } catch (err) {
        console.debug("[sovereign] ollama auto-link check skipped:", err);
      } finally {
        this.ollamaWatchInFlight = false;
      }
    };

    void check();
    this.ollamaWatchTimer = window.setInterval(() => void check(), OLLAMA_WATCH_INTERVAL_MS);
    this.registerInterval(this.ollamaWatchTimer);
  }

  /** Manual / wizard entry point: probe now and link when found. */
  async linkOllamaNow(): Promise<string> {
    const { probeOllama, linkOllamaToCore } = await import("./services/ollama");
    const probe = await probeOllama(
      this.settings.ollamaBaseUrl || undefined,
    );
    if (!probe.found) {
      return `Ollama not found at ${probe.baseUrl} (${probe.reason}). Start it with \`ollama serve\`.`;
    }
    const daemon = this.daemon;
    if (!daemon || daemon.getStatus() !== "running") {
      return "The core is not running, so Ollama cannot be linked right now.";
    }
    const client = daemonClient(daemon);
    const result = await linkOllamaToCore(probe, {
      dataDir: this.settings.dataDir || path.join(os.homedir(), "SovereignBrain"),
      request: <T,>(method: string, params: unknown) => client.request<T>(method, params),
    });
    if (result.linked) {
      if (result.embedLinked !== false) {
        void this.performSync(true);
      }
    }
    return result.message;
  }

  private async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<SovereignBrainSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
