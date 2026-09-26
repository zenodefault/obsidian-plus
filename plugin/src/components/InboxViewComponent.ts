import { App } from "obsidian";
import { mockService } from "../mock/mockData";

export class InboxViewComponent {
  private containerEl: HTMLElement;

  constructor(
    parentEl: HTMLElement,
    _app: App,
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

    const health = await mockService.getHealthMetrics();
    const ops = await mockService.getOperations();
    const pendingOpsCount = ops.filter((o) => o.status === "proposed").length;

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

    // Actions item
    const actionItem = list.createDiv({ cls: "sovereign-inbox-item" });
    const actionLeft = actionItem.createDiv({ cls: "sovereign-inbox-item-left" });
    actionLeft.createSpan({ text: "⚡ Proposed Actions", cls: "sovereign-inbox-item-title" });
    actionLeft.createSpan({
      text: `${pendingOpsCount} vault modification proposal`,
      cls: "sovereign-text-muted sovereign-text-xs",
    });
    const actionBadge = actionItem.createDiv({ cls: "sovereign-inbox-item-right" });
    const actionBtn = actionBadge.createEl("button", {
      text: `Inspect (${pendingOpsCount})`,
      cls: "sovereign-btn-sm sovereign-btn-secondary",
    });
    actionBtn.addEventListener("click", () => this.onNavigateTab("Actions"));

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
      text: "View in Ask",
      cls: "sovereign-btn-sm",
    });
    contBtn.addEventListener("click", () => this.onNavigateTab("Ask"));

    // Stale knowledge item
    const staleItem = list.createDiv({ cls: "sovereign-inbox-item" });
    const staleLeft = staleItem.createDiv({ cls: "sovereign-inbox-item-left" });
    staleLeft.createSpan({ text: "⏳ Stale Knowledge", cls: "sovereign-inbox-item-title" });
    staleLeft.createSpan({
      text: `${health.stale_knowledge} notes untouched for >180 days`,
      cls: "sovereign-text-muted sovereign-text-xs",
    });
    const staleBadge = staleItem.createDiv({ cls: "sovereign-inbox-item-right" });
    const staleBtn = staleBadge.createEl("button", {
      text: "Inspect",
      cls: "sovereign-btn-sm",
    });
    staleBtn.addEventListener("click", () => this.onNavigateTab("Brain Health"));
  }
}
