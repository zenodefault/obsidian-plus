import { App } from "obsidian";
import { CurrentNoteContext } from "../types/protocol";

export class CurrentNoteContextCard {
  private containerEl: HTMLElement;

  constructor(
    parentEl: HTMLElement,
    private app: App,
    private onAskAboutNote: (noteTitle: string) => void
  ) {
    this.containerEl = parentEl.createDiv({ cls: "sovereign-context-card" });
  }

  render(context: CurrentNoteContext): void {
    this.containerEl.empty();

    const header = this.containerEl.createDiv({ cls: "sovereign-context-header" });
    header.createSpan({ text: "CURRENT NOTE CONTEXT", cls: "sovereign-context-label" });
    const titleLink = header.createEl("a", {
      text: context.title,
      cls: "sovereign-context-filename",
    });
    titleLink.addEventListener("click", () => {
      void this.app.workspace.openLinkText(context.path, "", false);
    });

    const metricsGrid = this.containerEl.createDiv({ cls: "sovereign-context-grid" });
    const items = [
      { label: "Related Notes", value: `${context.related_notes_count}` },
      { label: "Memories", value: `${context.memories_count}` },
      { label: "Connections", value: `${context.potential_connections_count}` },
      {
        label: "Contradictions",
        value: `${context.contradictions_count}`,
        warning: context.contradictions_count > 0,
      },
    ];

    for (const item of items) {
      const metric = metricsGrid.createDiv({ cls: "sovereign-context-stat" });
      const valEl = metric.createSpan({ text: item.value, cls: "sovereign-stat-val" });
      if (item.warning) valEl.addClass("sovereign-text-warning");
      metric.createSpan({ text: item.label, cls: "sovereign-stat-label" });
    }

    if (context.similar_notes.length > 0) {
      const simContainer = this.containerEl.createDiv({ cls: "sovereign-context-similar" });
      simContainer.createSpan({ text: "Similar: ", cls: "sovereign-context-label-sub" });
      for (const note of context.similar_notes) {
        const chip = simContainer.createEl("a", {
          text: note.split("/").pop() ?? note,
          cls: "sovereign-chip",
        });
        chip.addEventListener("click", () => {
          void this.app.workspace.openLinkText(note, "", false);
        });
      }
    }

    const askBtn = this.containerEl.createEl("button", {
      text: "⚡ Ask about this note",
      cls: "sovereign-btn-secondary sovereign-btn-block",
    });
    askBtn.addEventListener("click", () => this.onAskAboutNote(context.title));
  }
}
