import { App } from "obsidian";
import { AskQueryResult } from "../types/protocol";
import { mockService } from "../mock/mockData";

export class AskViewComponent {
  private containerEl: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private resultContainerEl!: HTMLElement;
  private askButton!: HTMLButtonElement;

  constructor(
    parentEl: HTMLElement,
    private app: App,
    private onJumpToMemory?: (id: string) => void
  ) {
    this.containerEl = parentEl.createDiv({ cls: "sovereign-ask-view" });
    this.buildInputArea();
    this.resultContainerEl = this.containerEl.createDiv({ cls: "sovereign-ask-results" });
    // Render initial sample answer
    void this.performSearch("What are our architectural principles for Sovereign Second Brain?");
  }

  private buildInputArea(): void {
    const inputWrapper = this.containerEl.createDiv({ cls: "sovereign-ask-input-box" });

    this.inputEl = inputWrapper.createEl("textarea", {
      cls: "sovereign-textarea",
      attr: { placeholder: "What do you want to know about your vault?", rows: "3" },
    });

    const actionsRow = inputWrapper.createDiv({ cls: "sovereign-ask-actions" });

    const hints = actionsRow.createDiv({ cls: "sovereign-ask-hints" });
    const quickChip = hints.createEl("button", {
      text: "⚡ Core Architecture",
      cls: "sovereign-chip-btn",
    });
    quickChip.addEventListener("click", () => {
      this.inputEl.value = "What are our architectural principles for Sovereign Second Brain?";
      void this.performSearch(this.inputEl.value);
    });

    this.askButton = actionsRow.createEl("button", {
      text: "Ask Brain",
      cls: "mod-cta sovereign-btn-primary",
    });
    this.askButton.addEventListener("click", () => {
      const q = this.inputEl.value.trim();
      if (q) void this.performSearch(q);
    });

    this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        const q = this.inputEl.value.trim();
        if (q) void this.performSearch(q);
      }
    });
  }

  setQuery(query: string): void {
    this.inputEl.value = query;
    void this.performSearch(query);
  }

  private async performSearch(query: string): Promise<void> {
    this.resultContainerEl.empty();
    this.askButton.disabled = true;

    const loadingEl = this.resultContainerEl.createDiv({ cls: "sovereign-loading-state" });
    loadingEl.createDiv({ cls: "sovereign-spinner" });
    loadingEl.createSpan({ text: "Searching your knowledge locally...", cls: "sovereign-loading-text" });

    // Simulate async local retrieval delay
    await new Promise((resolve) => setTimeout(resolve, 350));

    const result = await mockService.queryAsk(query);
    this.askButton.disabled = false;
    this.renderResult(result);
  }

  private renderResult(result: AskQueryResult): void {
    this.resultContainerEl.empty();

    const card = this.resultContainerEl.createDiv({ cls: "sovereign-answer-card" });

    // Answer header
    const topRow = card.createDiv({ cls: "sovereign-answer-topbar" });
    topRow.createSpan({ text: "LOCAL SYNTHESIS", cls: "sovereign-badge-subtle" });
    topRow.createSpan({
      text: `● ${result.confidence.toUpperCase()} CONFIDENCE`,
      cls: `sovereign-conf-badge sovereign-conf-${result.confidence}`,
    });

    // Answer body
    const body = card.createDiv({ cls: "sovereign-answer-body" });
    body.createEl("p", { text: result.answer });

    // Potential Conflict alert if present
    if (result.conflicts && result.conflicts.length > 0) {
      for (const conflict of result.conflicts) {
        const conflictBox = card.createDiv({ cls: "sovereign-alert-box sovereign-alert-warning" });
        const cHeader = conflictBox.createDiv({ cls: "sovereign-alert-header" });
        cHeader.createSpan({ text: "⚠️ Potential Contradiction Detected", cls: "sovereign-alert-title" });

        const cGrid = conflictBox.createDiv({ cls: "sovereign-alert-grid" });
        const col1 = cGrid.createDiv({ cls: "sovereign-alert-col" });
        col1.createSpan({ text: "Earlier:", cls: "sovereign-text-muted sovereign-text-xs" });
        col1.createEl("blockquote", { text: `"${conflict.earlier}"` });
        col1.createEl("span", { text: conflict.earlier_source, cls: "sovereign-text-xs" });

        const col2 = cGrid.createDiv({ cls: "sovereign-alert-col" });
        col2.createSpan({ text: "Later:", cls: "sovereign-text-muted sovereign-text-xs" });
        col2.createEl("blockquote", { text: `"${conflict.later}"` });
        col2.createEl("span", { text: conflict.later_source, cls: "sovereign-text-xs" });

        const interp = conflictBox.createDiv({ cls: "sovereign-alert-interp" });
        interp.createSpan({ text: `Note: ${conflict.interpretation}`, cls: "sovereign-text-sm" });
      }
    }

    // Sources drawer
    if (result.sources.length > 0) {
      const srcSection = card.createDiv({ cls: "sovereign-sources-section" });
      const srcTitle = srcSection.createDiv({ cls: "sovereign-section-subhead" });
      srcTitle.createSpan({ text: `Sources (${result.sources.length})` });

      const srcList = srcSection.createDiv({ cls: "sovereign-sources-list" });
      for (const src of result.sources) {
        const srcCard = srcList.createDiv({ cls: "sovereign-source-item" });
        const link = srcCard.createEl("a", { text: `📄 ${src.title}`, cls: "sovereign-source-link" });
        link.addEventListener("click", () => {
          void this.app.workspace.openLinkText(src.path, "", false);
        });

        if (src.score) {
          srcCard.createSpan({
            text: `${Math.round(src.score * 100)}% match`,
            cls: "sovereign-source-score",
          });
        }
        srcCard.createEl("p", { text: src.excerpt, cls: "sovereign-source-excerpt" });
      }
    }

    // Related memories
    if (result.memories.length > 0) {
      const memSection = card.createDiv({ cls: "sovereign-memories-drawer" });
      memSection.createDiv({ cls: "sovereign-section-subhead", text: "Related Memory" });
      for (const mem of result.memories) {
        const memItem = memSection.createDiv({ cls: "sovereign-memory-chip" });
        memItem.createSpan({ text: `🧠 [${mem.type.toUpperCase()}] ${mem.statement}` });
        if (this.onJumpToMemory) {
          const jumpBtn = memItem.createEl("a", { text: "View →", cls: "sovereign-link-action" });
          jumpBtn.addEventListener("click", () => this.onJumpToMemory!(mem.id));
        }
      }
    }
  }
}
