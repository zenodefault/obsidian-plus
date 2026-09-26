import { App, Notice } from "obsidian";
import { MemoryItem, MemoryStatus } from "../types/protocol";
import type { BrainDataService } from "../services/brainDataService";

export class MemoryViewComponent {
  private containerEl: HTMLElement;
  private currentTab: MemoryStatus = "pending";
  private listEl!: HTMLElement;
  private tabButtons: Map<MemoryStatus, HTMLButtonElement> = new Map();

  constructor(
    parentEl: HTMLElement,
    private app: App,
    private brain: BrainDataService,
    private onMemoryUpdated?: () => void
  ) {
    this.containerEl = parentEl.createDiv({ cls: "sovereign-memory-view" });
    this.buildNav();
    this.listEl = this.containerEl.createDiv({ cls: "sovereign-memory-list" });
    void this.refresh();
  }

  private buildNav(): void {
    const navBar = this.containerEl.createDiv({ cls: "sovereign-subnav" });
    const statuses: { key: MemoryStatus; label: string }[] = [
      { key: "pending", label: "Pending Review" },
      { key: "accepted", label: "Accepted" },
      { key: "superseded", label: "Superseded" },
    ];

    for (const item of statuses) {
      const btn = navBar.createEl("button", {
        text: item.label,
        cls: `sovereign-subnav-btn ${this.currentTab === item.key ? "is-active" : ""}`,
      });
      btn.addEventListener("click", () => {
        this.currentTab = item.key;
        this.updateNavActiveState();
        void this.refresh();
      });
      this.tabButtons.set(item.key, btn);
    }
  }

  private updateNavActiveState(): void {
    this.tabButtons.forEach((btn, status) => {
      if (status === this.currentTab) {
        btn.addClass("is-active");
      } else {
        btn.removeClass("is-active");
      }
    });
  }

  async refresh(): Promise<void> {
    this.listEl.empty();
    let allMemories: MemoryItem[];
    try {
      allMemories = await this.brain.getMemories();
    } catch (err) {
      new Notice(`Could not load memories: ${err instanceof Error ? err.message : String(err)}`);
      allMemories = [];
    }
    const filtered = allMemories.filter((m) => m.status === this.currentTab);

    // Update tab counts
    this.tabButtons.forEach((btn, status) => {
      const count = allMemories.filter((m) => m.status === status).length;
      const baseLabel =
        status === "pending"
          ? "Pending"
          : status === "accepted"
          ? "Accepted"
          : "Superseded";
      btn.setText(`${baseLabel} (${count})`);
    });

    if (filtered.length === 0) {
      const emptyState = this.listEl.createDiv({ cls: "sovereign-empty-state" });
      emptyState.createSpan({
        text:
          this.currentTab === "pending"
            ? "No memories awaiting review. Write first-person statements (\"I prefer…\", \"I decided…\") in your notes and sync."
            : `No ${this.currentTab} memories recorded.`,
      });
      return;
    }

    for (const memory of filtered) {
      this.renderMemoryCard(memory);
    }
  }

  private renderMemoryCard(memory: MemoryItem): void {
    const card = this.listEl.createDiv({ cls: "sovereign-card sovereign-memory-card" });

    // Top metadata row
    const metaRow = card.createDiv({ cls: "sovereign-card-header" });
    metaRow.createSpan({
      text: memory.type.toUpperCase(),
      cls: `sovereign-badge sovereign-badge-${memory.type}`,
    });
    metaRow.createSpan({
      text: `${memory.confidence} confidence • ${memory.created_at}`,
      cls: "sovereign-text-muted sovereign-text-xs",
    });

    // Statement
    const stmt = card.createDiv({ cls: "sovereign-card-body" });
    stmt.createEl("p", { text: `"${memory.statement}"`, cls: "sovereign-memory-text" });

    // Provenance link (real source note, §52)
    const provRow = card.createDiv({ cls: "sovereign-card-footer" });
    const sourceLink = provRow.createEl("a", {
      text: `Source: ${memory.source_path}`,
      cls: "sovereign-link-source",
    });
    sourceLink.addEventListener("click", () => {
      void this.app.workspace.openLinkText(memory.source_path, "", false);
    });

    // Action triggers — real protocol transitions (§50)
    const actions = provRow.createDiv({ cls: "sovereign-btn-group" });
    if (memory.status === "pending") {
      const acceptBtn = actions.createEl("button", {
        text: "Accept",
        cls: "mod-cta sovereign-btn-sm",
      });
      acceptBtn.addEventListener("click", async () => {
        try {
          await this.brain.setMemoryStatus(memory.id, "accepted");
          new Notice("Memory accepted into sovereign knowledge store.");
        } catch (err) {
          new Notice(`Accept failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        await this.refresh();
        this.onMemoryUpdated?.();
      });

      const rejectBtn = actions.createEl("button", {
        text: "Reject",
        cls: "mod-warning sovereign-btn-sm",
      });
      rejectBtn.addEventListener("click", async () => {
        try {
          await this.brain.setMemoryStatus(memory.id, "rejected");
          new Notice("Memory rejected.");
        } catch (err) {
          new Notice(`Reject failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        await this.refresh();
        this.onMemoryUpdated?.();
      });
    } else if (memory.status === "accepted") {
      const superBtn = actions.createEl("button", {
        text: "Mark Superseded",
        cls: "sovereign-btn-sm sovereign-btn-secondary",
      });
      superBtn.addEventListener("click", async () => {
        try {
          await this.brain.setMemoryStatus(memory.id, "superseded");
          new Notice("Memory marked as superseded.");
        } catch (err) {
          new Notice(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        await this.refresh();
        this.onMemoryUpdated?.();
      });
    }
  }
}
