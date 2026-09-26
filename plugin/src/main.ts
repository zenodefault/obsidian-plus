/**
 * Sovereign Second Brain — Obsidian plugin entry point.
 *
 * Deliberately thin (PLAN.md §4.1): lifecycle wiring only. All intelligence
 * lives in the core process; UI surfaces come in a later workstream.
 */

import { Plugin } from "obsidian";
import * as os from "node:os";
import * as path from "node:path";
import { SovereignDaemon } from "./services/daemon";
import { resolveCoreBinary } from "./services/daemon/spawn";
import { DEFAULT_SETTINGS, SovereignBrainSettings } from "./settings/settings";

export default class SovereignSecondBrainPlugin extends Plugin {
  settings: SovereignBrainSettings = { ...DEFAULT_SETTINGS };
  private daemon: SovereignDaemon | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    // Never block Obsidian startup on the core (PLAN.md §91).
    void this.startDaemon();
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

  private async startDaemon(): Promise<void> {
    const pluginDir = this.manifest.dir ?? "";
    const binaryPath =
      this.settings.coreBinaryPath || resolveCoreBinary(pluginDir) || "";

    if (!binaryPath) {
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
    } catch (err) {
      console.error("[sovereign] core failed to start:", err);
      // Vault is untouched; the core can be restarted later.
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
