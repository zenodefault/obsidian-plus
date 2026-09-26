import { App } from "obsidian";
import type { BrainDataService } from "../services/brainDataService";
import type { AuditActivityItem } from "../types/protocol";

export class ActivityViewComponent {
  private containerEl: HTMLElement;

  constructor(parentEl: HTMLElement, _app: App, private brain: BrainDataService) {
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

    let activities: AuditActivityItem[];
    let chainValid = true;
    try {
      const trail = await this.brain.getActivityWithChain();
      activities = trail.events;
      chainValid = trail.chain_valid;
    } catch {
      activities = [];
      chainValid = true;
    }

    if (!this.brain.isOnline()) {
      const offlineEl = this.containerEl.createDiv({ cls: "sovereign-empty-state" });
      offlineEl.createSpan({ text: "The Sovereign core is not running. Start it from settings." });
      return;
    }

    // Chain integrity badge (§66)
    const badge = this.containerEl.createDiv({ cls: "sovereign-chain-status" });
    badge.createSpan({
      text: chainValid ? "✓ Audit chain verified" : "⚠ AUDIT CHAIN BROKEN — records were tampered with",
      cls: chainValid ? "sovereign-text-success" : "sovereign-text-warning",
    });

    if (activities.length === 0) {
      const emptyEl = this.containerEl.createDiv({ cls: "sovereign-empty-state" });
      emptyEl.createSpan({ text: "No activity yet. Sync your vault and review memories to build the trail." });
      return;
    }

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
    }
  }
}
