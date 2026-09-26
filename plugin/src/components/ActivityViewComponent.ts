import { App, Notice } from "obsidian";
import { mockService } from "../mock/mockData";

export class ActivityViewComponent {
  private containerEl: HTMLElement;

  constructor(parentEl: HTMLElement, _app: App) {
    this.containerEl = parentEl.createDiv({ cls: "sovereign-activity-view" });
    void this.render();
  }

  async render(): Promise<void> {
    this.containerEl.empty();

    const header = this.containerEl.createDiv({ cls: "sovereign-view-header" });
    header.createEl("h4", { text: "Audit Trail & Activity" });
    header.createEl("p", {
      text: "Cryptographic, chronological record of all Sovereign Brain events.",
      cls: "sovereign-text-muted sovereign-text-xs",
    });

    const activities = await mockService.getActivity();

    const timeline = this.containerEl.createDiv({ cls: "sovereign-timeline" });

    for (const act of activities) {
      const item = timeline.createDiv({ cls: "sovereign-timeline-item" });

      item.createDiv({ cls: `sovereign-timeline-dot sovereign-dot-${act.category}` });

      const content = item.createDiv({ cls: "sovereign-timeline-content" });
      const top = content.createDiv({ cls: "sovereign-timeline-top" });
      top.createSpan({ text: act.title, cls: "sovereign-timeline-title" });
      top.createSpan({ text: act.timestamp, cls: "sovereign-timeline-time" });

      if (act.detail) {
        content.createEl("p", { text: act.detail, cls: "sovereign-timeline-detail" });
      }

      if (act.category === "action") {
        const rollbackBtn = content.createEl("button", {
          text: "↩ Rollback Changes",
          cls: "sovereign-btn-sm sovereign-btn-secondary",
        });
        rollbackBtn.addEventListener("click", () => {
          new Notice(`Rollback prepared for: ${act.title}`);
        });
      }
    }
  }
}
