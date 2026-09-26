/**
 * Sovereign Second Brain — Obsidian plugin entry point.
 *
 * Deliberately thin (PLAN.md §4.1): lifecycle wiring only. All intelligence
 * lives in the core process; UI surfaces come in a later workstream.
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
import { SovereignSidebarView, VIEW_TYPE_SOVEREIGN_SIDEBAR } from "./views/SovereignSidebarView";
import { SovereignBrainSettingTab } from "./settings/SettingTab";
import { USE_MOCK_IPC } from "./config";

export default class SovereignSecondBrainPlugin extends Plugin {
  settings: SovereignBrainSettings = { ...DEFAULT_SETTINGS };
  private daemon: SovereignDaemon | null = null;
  private syncInFlight: Promise<void> | null = null;
  private syncQueued = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Register primary sidebar panel view
    this.registerView(
      VIEW_TYPE_SOVEREIGN_SIDEBAR,
      (leaf: WorkspaceLeaf) => new SovereignSidebarView(leaf)
    );

    // Ribbon icon to toggle/reveal sidebar
    this.addRibbonIcon("brain", "Sovereign Second Brain", () => {
      void this.activateView();
    });

    // Command palette action
    this.addCommand({
      id: "open-sovereign-sidebar",
      name: "Open Sovereign Brain sidebar",
      callback: () => {
        void this.activateView();
      },
    });

    // Settings Tab
    this.addSettingTab(new SovereignBrainSettingTab(this.app, this));

    // Never block Obsidian startup on the core (PLAN.md §91).
    void this.startDaemon();
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_SOVEREIGN_SIDEBAR)[0];
    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        await rightLeaf.setViewState({
          type: VIEW_TYPE_SOVEREIGN_SIDEBAR,
          active: true,
        });
        leaf = rightLeaf;
      }
    }
    if (leaf) {
      workspace.revealLeaf(leaf);
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
      if (USE_MOCK_IPC) {
        console.info("[sovereign] USE_MOCK_IPC is active — running UI decoupled from core binary.");
        return;
      }
      console.warn(
        "[sovereign] core binary not found — build core/ (scripts/build.sh) " +
          "or set coreBinaryPath in plugin settings.",
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
