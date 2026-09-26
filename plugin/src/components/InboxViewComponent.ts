import { App } from "obsidian";
import type { BrainDataService } from "../services/brainDataService";
import type { BrainHealthMetrics } from "../types/protocol";

export class InboxViewComponent {
  private containerEl: HTMLElement;

  constructor(
    parentEl: HTMLElement,
    _app: App,
    private brain: BrainDataService,
    private onNavigateTab: (tab: string) => void
  ) {
    this.containerEl = parentEl.createDiv({ cls: "sovereign-inbox-view" });
    void this.render();
  }

  async render(): Promise<void> {
    this.containerEl.empty();

    const header = this.containerEl.createDiv({ cls: "sovereign-view-header" });
    header.createEl("h4", { text: "Inbox & Triage" });
    header.createEl("p", {
      text: "Unreviewed items surfaced by the local knowledge engine.",
      cls: "sovereign-text-muted sovereign-text-xs",
    });

    const { health, offline } = await this.brain.getHealthDetailed();
    if (offline) {
      const offlineEl = this.containerEl.createDiv({ cls: "sovereign-empty-state" });
      offlineEl.createSpan({ text: "The Sovereign core is not running. Start it from settings." });
      return;
    }
    this.renderItems(health);
  }

  private renderItems(health: BrainHealthMetrics): void {
    const list = this.containerEl.createDiv({ cls: "sovereign-inbox-list" });

    // Memory candidates item
    const memItem = list.createDiv({ cls: "sovereign-inbox-item" });
    const memLeft = memItem.createDiv({ cls: "sovereign-inbox-item-left" });
    memLeft.createSpan({ text: "🧠 Memory Candidates", cls: "sovereign-inbox-item-title" });
    memLeft.createSpan({
      text: `${health.pending_memories} items waiting for user confirmation`,
      cls: "sovereign-text-muted sovereign-text-xs",
    });
    const memBadge = memItem.createDiv({ cls: "sovereign-inbox-item-right" });
    const memBtn = memBadge.createEl("button", {
      text: `Review (${health.pending_memories})`,
      cls: "sovereign-btn-sm mod-cta",
    });
    memBtn.addEventListener("click", () => this.onNavigateTab("Memory"));

    // Contradictions item
    const contItem = list.createDiv({ cls: "sovereign-inbox-item" });
    const contLeft = contItem.createDiv({ cls: "sovereign-inbox-item-left" });
    contLeft.createSpan({ text: "⚠️ Potential Contradictions", cls: "sovereign-inbox-item-title" });
    contLeft.createSpan({
      text: `${health.potential_contradictions} temporal conflicts flagged`,
      cls: "sovereign-text-muted sovereign-text-xs",
    });
    const contBadge = contItem.createDiv({ cls: "sovereign-inbox-item-right" });
    const contBtn = contBadge.createEl("button", {
      text: "Ask About It",
      cls: "sovereign-btn-sm",
    });
    contBtn.addEventListener("click", () => this.onNavigateTab("Ask"));

    // Duplicates item
    const dupItem = list.createDiv({ cls: "sovereign-inbox-item" });
    const dupLeft = dupItem.createDiv({ cls: "sovereign-inbox-item-left" });
    dupLeft.createSpan({ text: "📄 Possible Duplicates", cls: "sovereign-inbox-item-title" });
    dupLeft.createSpan({
      text: `${health.duplicate_notes} identical-content pairs found`,
      cls: "sovereign-text-muted sovereign-text-xs",
    });
    const dupBadge = dupItem.createDiv({ cls: "sovereign-inbox-item-right" });
    const dupBtn = dupBadge.createEl("button", {
      text: "Inspect",
      cls: "sovereign-btn-sm",
    });
    dupBtn.addEventListener("click", () => this.onNavigateTab("Brain Health"));

    // Broken links item
    const linkItem = list.createDiv({ cls: "sovereign-inbox-item" });
    const linkLeft = linkItem.createDiv({ cls: "sovereign-inbox-item-left" });
    linkLeft.createSpan({ text: "🔗 Broken Links", cls: "sovereign-inbox-item-title" });
    linkLeft.createSpan({
      text: `${health.broken_links} wiki-links do not resolve`,
      cls: "sovereign-text-muted sovereign-text-xs",
    });
    const linkBadge = linkItem.createDiv({ cls: "sovereign-inbox-item-right" });
    const linkBtn = linkBadge.createEl("button", {
      text: "Inspect",
      cls: "sovereign-btn-sm",
    });
    linkBtn.addEventListener("click", () => this.onNavigateTab("Brain Health"));
  }
}
