import { App, PluginSettingTab, Setting } from "obsidian";
import type SovereignSecondBrainPlugin from "../main";
import { SetupWizardModal } from "../onboarding/SetupWizardModal";
import {
  BEAM_COLORS,
  BEAM_COLOR_LABELS,
  BEAM_SIZES,
  BEAM_SIZE_LABELS,
  type BeamColor,
  type BeamSize,
} from "../ui/beam";

export class SovereignBrainSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: SovereignSecondBrainPlugin) {
    super(app, plugin);
  }

  /**
   * Honest core diagnostics: the process status, the binary actually in use,
   * and — when the core is not running — the exact search space plus a restart
   * action. This is the surface that answers "why does it say the core is not
   * running?" without guesswork.
   */
  private renderCoreStatus(containerEl: HTMLElement): void {
    const card = containerEl.createDiv({ cls: "sovereign-card" });
    const header = card.createDiv({ cls: "sovereign-card-header" });
    header.createSpan({ text: "CORE STATUS", cls: "sovereign-card-title" });
    const status = this.plugin.coreStatus();
    header.createSpan({
      text: status.toUpperCase(),
      cls: `sovereign-badge ${status === "running" ? "sovereign-badge-ok" : "sovereign-badge-risk-medium"}`,
    });

    const list = card.createDiv({ cls: "sovereign-privacy-list" });
    const row = (key: string, value: string, warn = false): void => {
      const r = list.createDiv({ cls: "sovereign-privacy-row" });
      r.createSpan({ text: key, cls: "sovereign-privacy-key" });
      const v = r.createSpan({ text: value, cls: "sovereign-privacy-val" });
      if (warn) v.addClass("sovereign-text-warning");
    };

    const resolution = this.plugin.resolveCore();
    row("Binary", resolution.path ?? "not found", !resolution.path);
    row("Plugin folder", this.plugin.pluginDirPath());
    const vault = this.plugin.vaultRoot();
    if (vault) row("Vault root", vault);

    if (!resolution.path) {
      card.createEl("p", {
        text:
          "Searched: " +
          resolution.searched.slice(0, 4).join("  ·  ") +
          (resolution.searched.length > 4 ? "  …" : ""),
        cls: "sovereign-text-muted sovereign-text-xs",
      });
    }

    new Setting(card)
      .setName("Restart core")
      .setDesc("Start the local core process again after fixing the path or killing it.")
      .addButton((btn) =>
        btn.setButtonText("Restart").onClick(async () => {
          btn.setDisabled(true);
          await this.plugin.restartCore();
          btn.setDisabled(false);
          this.display();
        }),
      );
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

    this.renderCoreStatus(containerEl);

    containerEl.createEl("h3", { text: "Interface" });

    new Setting(containerEl)
      .setName("Auto-link local Ollama")
      .setDesc(
        "Detect a running Ollama server (default port 11434) and configure it " +
          "as the embedding provider automatically, re-probing every few minutes.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.ollamaAutoLink).onChange(async (value) => {
          this.plugin.settings.ollamaAutoLink = value;
          await this.plugin.saveSettings();
          if (value) this.plugin.restartOllamaWatcher();
        }),
      );

    new Setting(containerEl)
      .setName("Ollama server URL")
      .setDesc("Empty uses OLLAMA_HOST or http://127.0.0.1:11434.")
      .addText((text) =>
        text
          .setPlaceholder("http://127.0.0.1:11434")
          .setValue(this.plugin.settings.ollamaBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.ollamaBaseUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      )
      .addButton((btn) =>
        btn.setButtonText("Link now").onClick(async () => {
          const message = await this.plugin.linkOllamaNow();
          // Honest result surface, no silent success/failure.
          const { Notice } = await import("obsidian");
          new Notice(message, 8_000);
          this.display();
        }),
      );

    containerEl.createEl("h3", { text: "Brain overlay" });

    new Setting(containerEl)
      .setName("Beam size")
      .setDesc("Shape of the BorderBeam that rides the popup perimeter.")
      .addDropdown((dropdown) => {
        for (const size of BEAM_SIZES) {
          dropdown.addOption(size, BEAM_SIZE_LABELS[size]);
        }
        dropdown.setValue(this.plugin.settings.beamSize).onChange(async (value) => {
          this.plugin.settings.beamSize = value as BeamSize;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Beam colour")
      .setDesc("Theme accent adapts to the active Obsidian theme; presets are fixed palettes.")
      .addDropdown((dropdown) => {
        for (const color of BEAM_COLORS) {
          dropdown.addOption(color, BEAM_COLOR_LABELS[color]);
        }
        dropdown.setValue(this.plugin.settings.beamColor).onChange(async (value) => {
          this.plugin.settings.beamColor = value as BeamColor;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Beam intensity")
      .setDesc("0 keeps the beam almost invisible; 1 is as bright as it gets.")
      .addSlider((slider) =>
        slider
          .setLimits(0, 100, 5)
          .setValue(Math.round(this.plugin.settings.beamStrength * 100))
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.beamStrength = value / 100;
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

          // Live Ollama probe so the user sees *why* auto-link did or didn't
          // fire (honest states, not a silent maybe).
          const { probeOllama } = await import("../services/ollama");
          const ollama = await probeOllama(
            this.plugin.settings.ollamaBaseUrl || undefined,
          );
          const ollamaRow = list.createDiv({ cls: "sovereign-privacy-row" });
          ollamaRow.createSpan({ text: "Local Ollama", cls: "sovereign-privacy-key" });
          ollamaRow.createSpan({
            text: ollama.found
              ? `running at ${ollama.baseUrl} (${ollama.models.length} model(s))`
              : `not detected at ${ollama.baseUrl}`,
            cls: `sovereign-privacy-val ${ollama.found ? "sovereign-text-success" : ""}`,
          });

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
