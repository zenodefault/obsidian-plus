import { App } from "obsidian";
import type { BrainDataService } from "../services/brainDataService";
import type { BrainHealthMetrics } from "../types/protocol";

export class BrainHealthComponent {
  private containerEl: HTMLElement;

  constructor(
    parentEl: HTMLElement,
    _app: App,
    private brain: BrainDataService,
    private onNavigateTab?: (tab: string) => void
  ) {
    this.containerEl = parentEl.createDiv({ cls: "sovereign-health-view" });
    void this.render();
  }

  async render(): Promise<void> {
    this.containerEl.empty();

    const header = this.containerEl.createDiv({ cls: "sovereign-view-header" });
    header.createEl("h4", { text: "Brain Health & Integrity" });
    header.createEl("p", {
      text: "Actionable local vault diagnostics. No vanity gamification scores.",
      cls: "sovereign-text-muted sovereign-text-xs",
    });

    const { health, offline } = await this.brain.getHealthDetailed();
    if (offline) {
      const offlineEl = this.containerEl.createDiv({ cls: "sovereign-empty-state" });
      offlineEl.createSpan({
        text: "The Sovereign core is not running. Start it from settings — your vault is safe and untouched.",
      });
      return;
    }

    this.renderCards(health);
  }

  private renderCards(metrics: BrainHealthMetrics): void {
    const cardsGrid = this.containerEl.createDiv({ cls: "sovereign-health-cards" });

    const items = [
      {
        icon: "✓",
        title: "Indexed Notes",
        value: `${metrics.indexed_notes} notes`,
        status: "ok",
        desc: "Active markdown notes parsed & locally indexed.",
        actionLabel: "Open Activity",
        action: () => this.onNavigateTab?.("Activity"),
      },
      {
        icon: metrics.pending_memories > 0 ? "⚠" : "✓",
        title: "Review Needed",
        value: `${metrics.pending_memories} memories`,
        status: metrics.pending_memories > 0 ? "warn" : "ok",
        desc: "Candidate facts requiring explicit user acceptance.",
        actionLabel: "Review Memories",
        action: () => this.onNavigateTab?.("Memory"),
      },
      {
        icon: metrics.potential_contradictions > 0 ? "⚠" : "✓",
        title: "Contradictions",
        value: `${metrics.potential_contradictions} detected`,
        status: metrics.potential_contradictions > 0 ? "warn" : "ok",
        desc: "Opposite statements on the same subject across notes.",
        actionLabel: "Inspect Conflict",
        action: () => this.onNavigateTab?.("Ask"),
      },
      {
        icon: metrics.duplicate_notes > 0 ? "⚠" : "✓",
        title: "Possible Duplicates",
        value: `${metrics.duplicate_notes} pairs`,
        status: metrics.duplicate_notes > 0 ? "warn" : "ok",
        desc: "Identical content across distinct note files.",
        actionLabel: "View Overlaps",
        action: () => this.onNavigateTab?.("Actions"),
      },
      {
        icon: metrics.broken_links > 0 ? "⚠" : "✓",
        title: "Broken Links",
        value: `${metrics.broken_links} errors`,
        status: metrics.broken_links > 0 ? "warn" : "ok",
        desc: "Internal wiki-links that do not resolve to a note.",
        actionLabel: "Resync Vault",
        action: () => this.onNavigateTab?.("Brain Health"),
      },
    ];

    for (const item of items) {
      const card = cardsGrid.createDiv({
        cls: `sovereign-health-card sovereign-status-${item.status}`,
      });
      const top = card.createDiv({ cls: "sovereign-health-card-top" });
      top.createSpan({ text: `${item.icon} ${item.title}`, cls: "sovereign-health-card-title" });
      top.createSpan({ text: item.value, cls: "sovereign-health-card-val" });

      card.createEl("p", { text: item.desc, cls: "sovereign-health-card-desc" });

      const actionBtn = card.createEl("button", {
        text: item.actionLabel,
        cls: "sovereign-btn-sm sovereign-btn-secondary",
      });
      actionBtn.addEventListener("click", item.action);
    }
  }
}
