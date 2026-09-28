/**
 * SetupWizardModal — first-run onboarding (Workstream: setup). Six steps:
 * welcome → core binary → data directory → local models → vault sync → done.
 *
 * Rules:
 * - Honest states only: every check reflects a real probe; nothing is
 *   pre-filled to look done (§29–31).
 * - Skippable and resumable: the user can bail at any step; the plugin
 *   keeps working and the wizard can be re-run from settings.
 * - Completing the wizard sets `onboardingComplete` so it never auto-opens
 *   twice.
 */

import { Modal, App, Notice, Setting } from "obsidian";
import type SovereignSecondBrainPlugin from "../main";
import { applyBeam } from "../ui/beam";
import {
  detectCoreBinary,
  probeBinaryPath,
  summarizeModelStatus,
  offlineModelSummary,
  type ModelSummary,
  type BinaryCheck,
} from "./setupCheck";

type StepIndex = 0 | 1 | 2 | 3 | 4 | 5;

const STEP_TITLES = [
  "Welcome",
  "Core binary",
  "Data directory",
  "Local models",
  "Vault sync",
  "Done",
];

export class SetupWizardModal extends Modal {
  private step: StepIndex = 0;
  private bodyEl!: HTMLElement;
  private footerEl!: HTMLElement;
  private stepIndicatorEl!: HTMLElement;
  private binaryCheck: BinaryCheck | null = null;
  private modelSummary: ModelSummary | null = null;
  private syncing = false;
  private syncDone = false;

  constructor(app: App, private plugin: SovereignSecondBrainPlugin) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl, modalEl } = this;
    modalEl.addClass("sovereign-wizard-modal");
    contentEl.empty();

    const frame = contentEl.createDiv({ cls: "sovereign-overlay-frame" });
    frame.createDiv({ cls: "sovereign-beam-layer" });
    // Same BorderBeam as the popup, with the user's chosen variant (the
    // wizard's narrower proportions still win via its own CSS variables).
    applyBeam(frame, {
      size: this.plugin.settings.beamSize,
      color: this.plugin.settings.beamColor,
      strength: this.plugin.settings.beamStrength,
      active: true,
    });

    const header = frame.createDiv({ cls: "sovereign-wizard-header" });
    this.stepIndicatorEl = header.createDiv({ cls: "sovereign-wizard-steps" });

    this.bodyEl = frame.createDiv({ cls: "sovereign-wizard-body" });
    this.footerEl = frame.createDiv({ cls: "sovereign-wizard-footer" });

    this.render();
  }

  onClose(): Promise<void> {
    this.contentEl.empty();
    return Promise.resolve();
  }

  // ---- rendering ---------------------------------------------------------

  private render(): void {
    this.renderStepIndicator();
    this.bodyEl.empty();
    this.footerEl.empty();

    switch (this.step) {
      case 0:
        this.renderWelcome();
        break;
      case 1:
        this.renderCoreBinary();
        break;
      case 2:
        this.renderDataDir();
        break;
      case 3:
        void this.renderModels();
        break;
      case 4:
        void this.renderSync();
        break;
      case 5:
        this.renderDone();
        break;
    }

  }

  private renderStepIndicator(): void {
    const el = this.stepIndicatorEl;
    el.empty();
    STEP_TITLES.forEach((title, i) => {
      const chip = el.createSpan({
        cls: `sovereign-wizard-step ${i === this.step ? "is-current" : ""} ${
          i < this.step ? "is-done" : ""
        }`,
      });
      chip.setText(String(i + 1));
      chip.setAttribute("aria-label", `${i + 1}. ${title}`);
    });
  }

  private addTitle(title: string, subtitle?: string): void {
    this.bodyEl.createEl("h3", { text: title, cls: "sovereign-wizard-title" });
    if (subtitle) {
      this.bodyEl.createEl("p", {
        text: subtitle,
        cls: "sovereign-wizard-subtitle",
      });
    }
  }

  private addNav(nextLabel: string, onNext: () => void, opts: { back?: boolean } = {}): void {
    const row = this.bodyEl.createDiv({ cls: "sovereign-wizard-actions" });
    if (opts.back !== false && this.step > 0) {
      const back = row.createEl("button", { text: "Back", cls: "sovereign-btn-secondary" });
      back.addEventListener("click", () => {
        this.step = (this.step - 1) as StepIndex;
        this.render();
      });
    }
    const next = row.createEl("button", { text: nextLabel, cls: "mod-cta sovereign-btn-primary" });
    next.addEventListener("click", onNext);
    const skip = row.createEl("button", {
      text: this.step === 4 ? "Skip sync" : "Skip setup",
      cls: "sovereign-wizard-skip",
    });
    skip.addEventListener("click", () => void this.finish());
  }

  // ---- steps ---------------------------------------------------------------

  private renderWelcome(): void {
    this.addTitle(
      "Sovereign Second Brain",
      "A completely local intelligence layer for your vault. Zero cloud, zero " +
        "telemetry, zero accounts — the core runs on this machine and talks only " +
        "to this plugin. Five short steps and you're set.",
    );
    const list = this.bodyEl.createDiv({ cls: "sovereign-wizard-list" });
    for (const [k, v] of [
      ["Local core", "A small Rust process indexes and searches your notes."],
      ["Your vault, untouched", "The core never writes files. All changes go through you."],
      ["Memories you approve", "Facts are candidates until you accept them."],
    ]) {
      const row = list.createDiv({ cls: "sovereign-wizard-list-row" });
      row.createSpan({ text: k, cls: "sovereign-wizard-list-key" });
      row.createSpan({ text: v, cls: "sovereign-wizard-list-val" });
    }
    this.addNav("Get started", () => {
      this.step = 1;
      this.render();
    });
  }

  private renderCoreBinary(): void {
    this.addTitle(
      "Core binary",
      "The plugin spawns sovereign-core as a child process. It is detected " +
        "automatically, or you can point at a specific binary.",
    );

    if (!this.binaryCheck) {
      this.binaryCheck = detectCoreBinary(this.plugin.manifest.dir ?? "");
    }

    const check = this.binaryCheck;
    const status = this.bodyEl.createDiv({
      cls: `sovereign-wizard-status ${check.ok ? "is-ok" : "is-warn"}`,
    });
    status.createSpan({
      text: check.ok ? `✓ ${check.path}` : `✕ not found`,
      cls: "sovereign-wizard-status-text",
    });
    this.bodyEl.createEl("p", { text: check.message, cls: "sovereign-wizard-subtitle" });

    new Setting(this.bodyEl)
      .setName("Binary path")
      .setDesc("Leave as-is to use the detected path.")
      .addText((text) =>
        text
          .setPlaceholder(check.path || "path to sovereign-core")
          .setValue(this.plugin.settings.coreBinaryPath)
          .onChange(async (value) => {
            this.plugin.settings.coreBinaryPath = value.trim();
            await this.plugin.saveSettings();
          }),
      )
      .addButton((btn) =>
        btn.setButtonText("Test path").onClick(async () => {
          const candidate = this.plugin.settings.coreBinaryPath || check.path;
          const probe = probeBinaryPath(candidate);
          this.binaryCheck = probe;
          if (probe.ok) {
            new Notice("Binary found and executable.");
          } else {
            new Notice("That path is not an executable file.");
          }
          this.render();
        }),
      );

    this.addNav("Next", () => {
      this.step = 2;
      this.render();
    });
  }

  private renderDataDir(): void {
    this.addTitle(
      "Data directory",
      "Where the core keeps its local state: the SQLite index, vectors and " +
        "memories. Your vault is only ever read, never written, by the core.",
    );

    new Setting(this.bodyEl)
      .setName("Data directory")
      .setDesc("Empty means the default: ~/SovereignBrain")
      .addText((text) =>
        text
          .setPlaceholder("~/SovereignBrain")
          .setValue(this.plugin.settings.dataDir)
          .onChange(async (value) => {
            this.plugin.settings.dataDir = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    this.addNav("Next", () => {
      this.step = 3;
      this.render();
    });
  }

  private async renderModels(): Promise<void> {
    this.addTitle(
      "Local models",
      "Everything runs on this machine. The built-in embedder needs no setup; " +
        "a local Ollama or GGUF model is optional and can be linked automatically.",
    );

    // Paint the full step immediately (nav included), then let the two
    // probes stream their results in — a slow core or Ollama probe must
    // never make the step feel frozen.
    const modelSlot = this.bodyEl.createDiv();
    this.bodyEl.createEl("p", {
      text: "Models are never downloaded by this plugin. A local Ollama server " +
        "is detected and linked automatically when it is running; otherwise a " +
        "llama.cpp-style binary and GGUF file can be configured in settings.",
      cls: "sovereign-wizard-footnote",
    });
    const ollamaSlot = this.bodyEl.createDiv();

    this.addNav("Next", () => {
      this.step = 4;
      this.render();
    });

    void this.fillModelStatus(modelSlot);
    await this.renderOllama(ollamaSlot);
  }

  /** Resolve (or reuse) the model summary from the live core. */
  private async resolveModelSummary(): Promise<ModelSummary> {
    if (this.modelSummary) return this.modelSummary;
    // Make sure the daemon had a chance to start with the chosen settings.
    if (!this.plugin.getDaemon()) {
      await this.plugin.ensureDaemon();
    }
    const daemon = this.plugin.getDaemon();
    if (!daemon) {
      this.modelSummary = offlineModelSummary();
      return this.modelSummary;
    }
    try {
      const client = this.plugin.getClientFactory()();
      if (!client || client.getStatus() !== "running") {
        this.modelSummary = offlineModelSummary();
      } else {
        const status = await client.request<import("../vault/types").ModelStatus>("models.status", {});
        this.modelSummary = summarizeModelStatus(status);
      }
    } catch {
      this.modelSummary = offlineModelSummary();
    }
    return this.modelSummary;
  }

  /** Stream the core's model status into the models step. */
  private async fillModelStatus(slot: HTMLElement): Promise<void> {
    const s = await this.resolveModelSummary();
    if (!slot.isConnected) return;
    slot.empty();

    const box = slot.createDiv({
      cls: `sovereign-wizard-status ${s.provider === "unknown" ? "is-warn" : "is-ok"}`,
    });
    box.createSpan({ text: s.message, cls: "sovereign-wizard-status-text" });

    if (s.total > 0) {
      const pct = Math.floor((s.embedded / s.total) * 100);
      const meter = slot.createDiv({ cls: "sovereign-wizard-meter" });
      const fill = meter.createDiv({ cls: "sovereign-wizard-meter-fill" });
      fill.style.width = `${pct}%`;
      slot.createEl("p", {
        text: `${s.embedded} of ${s.total} chunks embedded (${pct}%)`,
        cls: "sovereign-wizard-subtitle",
      });
    }
  }

  /** Ollama auto-detect card for the models step. */
  private async renderOllama(slot: HTMLElement): Promise<void> {
    const card = slot.createDiv({ cls: "sovereign-wizard-status" });
    const text = card.createSpan({ cls: "sovereign-wizard-status-text" });
    text.setText("Checking for a local Ollama server…");

    const { probeOllama } = await import("../services/ollama");
    const probe = await probeOllama(
      this.plugin.settings.ollamaBaseUrl || undefined,
    );
    // The user may have left the step while the probe was in flight.
    if (!card.isConnected) return;

    if (!probe.found) {
      card.addClass("is-idle");
      text.setText(
        `No local Ollama at ${probe.baseUrl} — that is fine. Install it from ` +
          "ollama.com and start it; the plugin links it automatically once it runs.",
      );
      return;
    }

    card.addClass("is-ok");
    const names = probe.models.map((m) => m.name);
    text.setText(
      `Ollama is running at ${probe.baseUrl} with ${names.length} model(s): ` +
        (names.slice(0, 3).join(", ") + (names.length > 3 ? "…" : "") || "none yet"),
    );

    const row = slot.createDiv({ cls: "sovereign-wizard-actions" });
    const linkBtn = row.createEl("button", {
      text: "Link Ollama to the brain",
      cls: "mod-cta sovereign-btn-primary",
    });
    linkBtn.addEventListener("click", async () => {
      linkBtn.disabled = true;
      text.setText("Linking…");
      const message = await this.plugin.linkOllamaNow();
      if (!card.isConnected) return; // user left the step mid-link
      text.setText(message);
      new Notice(message, 8_000);
      // Refresh the model summary; the provider may have changed.
      this.modelSummary = null;
    });
  }

  private async renderSync(): Promise<void> {
    this.addTitle(
      "Vault sync",
      "The plugin reads your notes and sends them to the local core for " +
        "indexing. This happens automatically in the background; run it now " +
        "to see it work.",
    );

    const statusEl = this.bodyEl.createDiv({ cls: "sovereign-wizard-status is-idle" });
    const statusText = statusEl.createSpan({ cls: "sovereign-wizard-status-text" });

    if (this.syncDone) {
      statusEl.removeClass("is-idle");
      statusEl.addClass("is-ok");
      statusText.setText("✓ Initial sync complete. The brain is indexed.");
    } else if (!this.syncing) {
      statusText.setText("Ready when you are.");
    } else {
      statusText.setText("Syncing… large vaults take a moment.");
    }

    if (!this.syncDone && !this.syncing) {
      const actions = this.bodyEl.createDiv({ cls: "sovereign-wizard-actions" });
      const run = actions.createEl("button", {
        text: "Sync now",
        cls: "mod-cta sovereign-btn-primary",
      });
      run.addEventListener("click", async () => {
        this.syncing = true;
        this.render();
        try {
          await this.plugin.syncNow();
          this.syncDone = true;
          new Notice("Initial vault sync complete.");
        } catch (err) {
          new Notice(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          this.syncing = false;
          this.render();
        }
      });
    }

    this.addNav("Next", () => {
      this.step = 5;
      this.render();
    });
  }

  private renderDone(): void {
    this.addTitle(
      "You're set.",
      "Open the brain anytime with the hotkey (default Ctrl/Cmd+Shift+B), or " +
        "from the brain icon in the left ribbon. The knowledge graph lives in " +
        "the left sidebar — click the fork icon.",
    );
    const list = this.bodyEl.createDiv({ cls: "sovereign-wizard-list" });
    for (const [k, v] of [
      ["Ask the brain", "Hotkey → overlay → type your question."],
      ["Review memories", "Facts appear as candidates; accept or reject them."],
      ["Everything local", "No cloud. No accounts. No telemetry. Ever."],
    ]) {
      const row = list.createDiv({ cls: "sovereign-wizard-list-row" });
      row.createSpan({ text: k, cls: "sovereign-wizard-list-key" });
      row.createSpan({ text: v, cls: "sovereign-wizard-list-val" });
    }
    this.addNav("Finish", () => void this.finish(), { back: true });
  }

  /** Mark setup complete and close. */
  private async finish(): Promise<void> {
    this.plugin.settings.onboardingComplete = true;
    await this.plugin.saveSettings();
    this.close();
  }
}
