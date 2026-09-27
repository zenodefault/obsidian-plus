/**
 * Sovereign Second Brain — Obsidian plugin entry point.
 *
 * Deliberately thin (PLAN.md §4.1): lifecycle wiring only. All intelligence
 * lives in the core process.
 *
 * UI surfaces (Workstream: overlay + graph + setup):
 * - `SovereignOverlayModal` — hotkey popup hosting the full brain panel.
 * - `SovereignGraphView` — left-sidebar knowledge graph.
 * - `SetupWizardModal` — first-run onboarding.
 */

import { Plugin, WorkspaceLeaf } from "obsidian";
import * as os from "node:os";
import * as path from "node:path";
import { SovereignDaemon } from "./services/daemon";
import { resolveCoreBinary } from "./services/daemon/spawn";
import { DEFAULT_SETTINGS, SovereignBrainSettings } from "./settings/settings";
import { buildInventory, readNote } from "./vault/inventory";
import { runSync, SyncAbortedError } from "./vault/sync";
import { createVaultWatcher } from "./vault/attach";
import { SovereignBrainSettingTab } from "./settings/SettingTab";
import {
  openSovereignOverlay,
} from "./views/SovereignOverlayModal";
import {
  SovereignGraphView,
  VIEW_TYPE_SOVEREIGN_GRAPH,
} from "./views/SovereignGraphView";
import { SetupWizardModal } from "./onboarding/SetupWizardModal";
import {
  RealBrainDataService,
  daemonClient,
} from "./services/brainDataService";
import {
  OperationService,
  obsidianVaultBridge,
} from "./services/operationService";

export default class SovereignSecondBrainPlugin extends Plugin {
  settings: SovereignBrainSettings = { ...DEFAULT_SETTINGS };
  private daemon: SovereignDaemon | null = null;
  private brain: RealBrainDataService | null = null;
  private operations: OperationService | null = null;
  private syncInFlight: Promise<void> | null = null;
  private syncQueued = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Knowledge graph leaf (left sidebar, own ribbon icon).
    this.registerView(
      VIEW_TYPE_SOVEREIGN_GRAPH,
      (leaf: WorkspaceLeaf) => new SovereignGraphView(leaf, this),
    );

    // Ribbon: brain icon → hotkey overlay.
    this.addRibbonIcon("brain", "Sovereign Brain (overlay)", () => {
      this.openOverlay();
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
      id: "open-sovereign-graph",
      name: "Open knowledge graph",
      callback: () => {
        void this.activateGraphView();
      },
    });

    this.addCommand({
      id: "run-sovereign-setup",
      name: "Run setup wizard",
      callback: () => {
        new SetupWizardModal(this.app, this).open();
      },
    });

    // Settings Tab
    this.addSettingTab(new SovereignBrainSettingTab(this.app, this));

    // Never block Obsidian startup on the core (PLAN.md §91).
    void this.startDaemon();

    // First-run: open the setup wizard once, after the workspace settles.
    if (!this.settings.onboardingComplete) {
      this.app.workspace.onLayoutReady(() => {
        new SetupWizardModal(this.app, this).open();
      });
    }
  }

  /** Open the overlay popup with the current services. */
  private openOverlay(): void {
    openSovereignOverlay(this.app, this, {
      brain: this.brainData(),
      operations: this.operationService(),
    });
  }

  /** Reveal (or create) the knowledge graph leaf in the left sidebar. */
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

  onunload(): void {
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
  private brainData(): RealBrainDataService {
    this.brain =
      this.brain ?? new RealBrainDataService(() => (this.daemon ? daemonClient(this.daemon) : null));
    return this.brain;
  }

  private operationService(): OperationService {
    if (!this.operations) {
      this.operations = new OperationService(
        () => (this.daemon ? daemonClient(this.daemon) : null),
        obsidianVaultBridge(this.app.vault),
      );
    }
    return this.operations;
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

  private async startDaemon(): Promise<void> {
    const pluginDir = this.manifest.dir ?? "";
    const binaryPath =
      this.settings.coreBinaryPath || resolveCoreBinary(pluginDir) || "";

    if (!binaryPath) {
      console.warn(
        "[sovereign] core binary not found — build core/ (scripts/build.sh) " +
          "or set coreBinaryPath in plugin settings. UI surfaces show offline states.",
      );
      return;
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
        `[sovereign] core running v${health.version} (protocol v${health.protocol_version}, pid ${health.pid})`,
      );
      this.attachVaultEvents();
      // Initial sync in the background (§91: startup never waits).
      void this.syncNow();
    } catch (err) {
      console.error("[sovereign] core failed to start:", err);
      // Vault is untouched; the core can be restarted later.
    }
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

  private async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<SovereignBrainSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored ?? {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
