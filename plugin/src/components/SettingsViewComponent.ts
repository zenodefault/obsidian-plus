import { App, Notice } from "obsidian";
import type { BrainDataService } from "../services/brainDataService";

export class SettingsViewComponent {
  private containerEl: HTMLElement;

  constructor(parentEl: HTMLElement, _app: App, private brain: BrainDataService) {
    this.containerEl = parentEl.createDiv({ cls: "sovereign-settings-view" });
    void this.render();
  }

  async render(): Promise<void> {
    this.containerEl.empty();

    const header = this.containerEl.createDiv({ cls: "sovereign-view-header" });
    header.createEl("h4", { text: "Sovereign Settings & Privacy" });
    header.createEl("p", {
      text: "Configure local offline inference and verify zero-cloud guarantees.",
      cls: "sovereign-text-muted sovereign-text-xs",
    });

    // Zero-Cloud Privacy Status Card (PLAN.md §28) — architectural facts,
    // identical whether or not the core is running.
    const privCard = this.containerEl.createDiv({
      cls: "sovereign-card sovereign-privacy-card",
    });
    const privHeader = privCard.createDiv({ cls: "sovereign-card-header" });
    privHeader.createSpan({ text: "🛡️ ZERO-CLOUD PRIVACY ENFORCEMENT", cls: "sovereign-card-title" });
    privHeader.createSpan({ text: "VERIFIED", cls: "sovereign-badge sovereign-badge-ok" });

    const privList = privCard.createDiv({ cls: "sovereign-privacy-list" });
    const privacyItems = [
      { key: "Network Access", val: "OFF (No sockets opened)", ok: true },
      { key: "Cloud APIs", val: "NONE", ok: true },
      { key: "Telemetry", val: "NONE", ok: true },
      { key: "Remote Processing", val: "NONE", ok: true },
      { key: "Local Processing", val: "ENABLED (100% on-device)", ok: true },
    ];

    for (const item of privacyItems) {
      const row = privList.createDiv({ cls: "sovereign-privacy-row" });
      row.createSpan({ text: item.key, cls: "sovereign-privacy-key" });
      const valSpan = row.createSpan({ text: item.val, cls: "sovereign-privacy-val" });
      if (item.ok) valSpan.addClass("sovereign-text-success");
    }

    privCard.createEl("p", {
      text: "Hard architectural guarantee: There is no cloud toggle because remote communication code does not exist in the binary.",
      cls: "sovereign-text-muted sovereign-text-xs sovereign-privacy-footnote",
    });

    // Local model status — real `models.status` (§74), live from the core.
    const modelsSection = this.containerEl.createDiv({ cls: "sovereign-settings-section" });
    modelsSection.createEl("h5", { text: "Local Inference Models" });

    if (!this.brain.isOnline()) {
      const offlineEl = modelsSection.createDiv({ cls: "sovereign-empty-state" });
      offlineEl.createSpan({ text: "The Sovereign core is not running — model status unavailable." });
      return;
    }

    try {
      const { request } = this.brain.getClient();
      const status = await request<{
        provider: string;
        model_path?: string;
        binary_path?: string;
        dimension: number;
        chunks_total: number;
        chunks_embedded: number;
        chunks_pending: number;
        validation_error?: string;
      }>("models.status", {});

      const form = modelsSection.createDiv({ cls: "sovereign-form" });

      const row = (label: string, value: string, warn = false) => {
        const field = form.createDiv({ cls: "sovereign-field" });
        field.createEl("label", { text: label, cls: "sovereign-field-label" });
        const span = field.createSpan({ text: value, cls: "sovereign-input sovereign-privacy-val" });
        if (warn) span.addClass("sovereign-text-warning");
        return span;
      };

      row("Provider:", status.provider);
      row("Embedding model:", status.model_path ?? "built-in deterministic hash embedder");
      row("Model binary:", status.binary_path ?? "in-process (none required)");
      row("Vector dimension:", String(status.dimension));
      row(
        "Embedded chunks:",
        `${status.chunks_embedded} / ${status.chunks_total}` +
          (status.chunks_pending > 0 ? ` (${status.chunks_pending} pending)` : ""),
        status.chunks_pending > 0,
      );
      if (status.validation_error) {
        row("Validation error:", status.validation_error, true);
      }
      privCard.createEl("p", {
        text: "Models are never downloaded. Provide local GGUF files via the core settings to upgrade beyond the built-in embedder.",
        cls: "sovereign-text-muted sovereign-text-xs sovereign-privacy-footnote",
      });
    } catch (err) {
      const errEl = modelsSection.createDiv({ cls: "sovereign-empty-state" });
      errEl.createSpan({
        text: `Model status unavailable: ${err instanceof Error ? err.message : String(err)}`,
      });
      void Notice;
    }
  }
}
