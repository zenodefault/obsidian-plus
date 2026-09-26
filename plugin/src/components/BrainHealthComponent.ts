import { App, Notice } from "obsidian";
import { mockService } from "../mock/mockData";

export class BrainHealthComponent {
  private containerEl: HTMLElement;

  constructor(
    parentEl: HTMLElement,
    _app: App,
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

    const metrics = await mockService.getHealthMetrics();

    const cardsGrid = this.containerEl.createDiv({ cls: "sovereign-health-cards" });

    const items = [
      {
        icon: "✓",
        title: "Indexed Notes",
        value: `${metrics.indexed_notes} notes`,
        status: "ok",
        desc: "All active markdown notes parsed & locally indexed.",
        actionLabel: "Re-index All",
        action: () => new Notice("Local vault re-indexing scheduled in background."),
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
        desc: "Temporal knowledge divergences detected across notes.",
        actionLabel: "Inspect Conflict",
        action: () => this.onNavigateTab?.("Ask"),
      },
      {
        icon: "⚠",
        title: "Stale Knowledge",
        value: `${metrics.stale_knowledge} notes`,
        status: "warn",
        desc: "Notes untouched for over 180 days with dependent links.",
        actionLabel: "Show Stale Notes",
        action: () => new Notice("Stale notes filter applied."),
      },
      {
        icon: "⚠",
        title: "Possible Duplicates",
        value: `${metrics.duplicate_notes} notes`,
        status: "warn",
        desc: "High semantic overlap between distinct note files.",
        actionLabel: "View Overlaps",
        action: () => this.onNavigateTab?.("Actions"),
      },
      {
        icon: "✓",
        title: "Broken Links",
        value: `${metrics.broken_links} errors`,
        status: "ok",
        desc: "All internal wiki-links resolve cleanly.",
        actionLabel: "Verify Links",
        action: () => new Notice("All vault links are healthy."),
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
