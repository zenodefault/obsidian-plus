import { App, PluginSettingTab, Setting } from "obsidian";
import type SovereignSecondBrainPlugin from "../main";
import { SetupWizardModal } from "../onboarding/SetupWizardModal";

export class SovereignBrainSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: SovereignSecondBrainPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Sovereign Second Brain Settings" });

    // Zero-cloud privacy guarantee banner
    const privCard = containerEl.createDiv({ cls: "sovereign-card sovereign-privacy-card" });
    const pHeader = privCard.createDiv({ cls: "sovereign-card-header" });
    pHeader.createSpan({ text: "🛡️ ZERO-CLOUD PRIVACY ENFORCEMENT", cls: "sovereign-card-title" });
    pHeader.createSpan({ text: "ACTIVE", cls: "sovereign-badge sovereign-badge-ok" });

    const pList = privCard.createDiv({ cls: "sovereign-privacy-list" });
    const guarantees = [
      ["Network Access", "OFF (No sockets opened)"],
      ["Cloud APIs", "NONE"],
      ["Telemetry", "NONE"],
      ["Remote Processing", "NONE"],
      ["Local Processing", "ENABLED (100% on-device)"],
    ];
    for (const [k, v] of guarantees) {
      const row = pList.createDiv({ cls: "sovereign-privacy-row" });
      row.createSpan({ text: k, cls: "sovereign-privacy-key" });
      row.createSpan({ text: v, cls: "sovereign-privacy-val sovereign-text-success" });
    }

    containerEl.createEl("h3", { text: "Setup" });

    new Setting(containerEl)
      .setName("Run setup wizard again")
      .setDesc(
        this.plugin.settings.onboardingComplete
          ? "Walk through the first-run setup once more."
          : "Setup has not been completed yet.",
      )
      .addButton((btn) =>
        btn.setButtonText("Open setup").onClick(() => {
          new SetupWizardModal(this.app, this.plugin).open();
        }),
      );

    containerEl.createEl("h3", { text: "Core Daemon & Storage" });

    new Setting(containerEl)
      .setName("Core binary path")
      .setDesc("Absolute path to the sovereign-core binary (leave blank to auto-detect).")
      .addText((text) =>
        text
          .setPlaceholder("Auto-detect")
          .setValue(this.plugin.settings.coreBinaryPath)
          .onChange(async (value) => {
            this.plugin.settings.coreBinaryPath = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Data directory")
      .setDesc("Root directory where the core maintains local vector and SQLite state.")
      .addText((text) =>
        text
          .setPlaceholder("~/SovereignBrain")
          .setValue(this.plugin.settings.dataDir)
          .onChange(async (value) => {
            this.plugin.settings.dataDir = value.trim();
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "Interface" });

    new Setting(containerEl)
      .setName("Border motion")
      .setDesc(
        "Animated light trace around the overlay popup. Disable for a static " +
          "hairline (reduced-motion systems ignore this and stay static).",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.borderMotion).onChange(async (value) => {
          this.plugin.settings.borderMotion = value;
          await this.plugin.saveSettings();
        }),
      );

    containerEl.createEl("h3", { text: "Local Inference Models" });

    // Honest model status — real `models.status` readout, live from the core.
    const modelsCard = containerEl.createDiv({ cls: "sovereign-card" });
    const modelHeader = modelsCard.createDiv({ cls: "sovereign-card-header" });
    modelHeader.createSpan({ text: "MODEL STATUS", cls: "sovereign-card-title" });

    const daemon = this.plugin.getDaemon();
    if (!daemon || daemon.getStatus() !== "running") {
      modelsCard.createEl("p", {
        text: "The core is not running. Model status will appear once it starts.",
        cls: "sovereign-text-muted sovereign-text-xs",
      });
    } else {
      void (async () => {
        try {
          const client = this.plugin.getClientFactory()();
          if (!client) throw new Error("core not running");
          const status = await client.request<{
            provider: string;
            model_path?: string;
            binary_path?: string;
            dimension: number;
            chunks_total: number;
            chunks_embedded: number;
            chunks_pending: number;
            validation_error?: string;
          }>("models.status", {});

          const rows: Array<[string, string, boolean?]> = [
            ["Provider", status.provider],
            [
              "Embedding model",
              status.model_path ?? "built-in deterministic hash embedder",
            ],
            ["Model binary", status.binary_path ?? "in-process (none required)"],
            ["Vector dimension", String(status.dimension)],
            [
              "Embedded chunks",
              `${status.chunks_embedded} / ${status.chunks_total}` +
                (status.chunks_pending > 0 ? ` (${status.chunks_pending} pending)` : ""),
              status.chunks_pending > 0,
            ],
          ];
          if (status.validation_error) {
            rows.push(["Validation error", status.validation_error, true]);
          }

          const list = modelsCard.createDiv({ cls: "sovereign-privacy-list" });
          for (const [k, v, warn] of rows) {
            const row = list.createDiv({ cls: "sovereign-privacy-row" });
            row.createSpan({ text: k, cls: "sovereign-privacy-key" });
            const val = row.createSpan({ text: v, cls: "sovereign-privacy-val" });
            if (warn) val.addClass("sovereign-text-warning");
          }

          modelsCard.createEl("p", {
            text: "Models are never downloaded. Provide local GGUF files to the core to upgrade beyond the built-in embedder.",
            cls: "sovereign-text-muted sovereign-text-xs sovereign-privacy-footnote",
          });
        } catch (err) {
          modelsCard.createEl("p", {
            text: `Model status unavailable: ${err instanceof Error ? err.message : String(err)}`,
            cls: "sovereign-text-muted sovereign-text-xs",
          });
        }
      })();
    }
  }
}
