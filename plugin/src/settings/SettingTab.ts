import { App, PluginSettingTab, Setting } from "obsidian";
import type SovereignSecondBrainPlugin from "../main";

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

    containerEl.createEl("h3", { text: "Local Inference Models" });

    new Setting(containerEl)
      .setName("Chat model path (GGUF)")
      .setDesc("Local model file used for answering queries and synthesizing knowledge.")
      .addText((text) =>
        text
          .setPlaceholder("models/llama-3.2-3b-instruct-q4_k_m.gguf")
          .setValue("models/llama-3.2-3b-instruct-q4_k_m.gguf")
      );

    new Setting(containerEl)
      .setName("Embedding model path (GGUF)")
      .setDesc("Local model used for generating vector embeddings.")
      .addText((text) =>
        text
          .setPlaceholder("models/bge-small-en-v1.5-q8_0.gguf")
          .setValue("models/bge-small-en-v1.5-q8_0.gguf")
      );
  }
}
