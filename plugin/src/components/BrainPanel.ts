/**
 * BrainPanel — the full brain UI (tabs, context card, status bar) as a
 * standalone component. Originally the body of the sidebar view; now hosted
 * by the hotkey overlay (Workstream: overlay popup). The tab components are
 * reused unchanged — this file only composes them.
 */

import { App, TFile } from "obsidian";
import type { BrainDataService } from "../services/brainDataService";
import type { OperationService } from "../services/operationService";
import { CurrentNoteContextCard } from "./CurrentNoteContextCard";
import { AskViewComponent } from "./AskViewComponent";
import { MemoryViewComponent } from "./MemoryViewComponent";
import { InboxViewComponent } from "./InboxViewComponent";
import { ActionsViewComponent } from "./ActionsViewComponent";
import { BrainHealthComponent } from "./BrainHealthComponent";
import { ActivityViewComponent } from "./ActivityViewComponent";
import { SettingsViewComponent } from "./SettingsViewComponent";

export type SovereignTab =
  | "Ask"
  | "Memory"
  | "Inbox"
  | "Actions"
  | "Brain Health"
  | "Activity"
  | "Settings";

export const SOVEREIGN_TABS: SovereignTab[] = [
  "Ask",
  "Memory",
  "Inbox",
  "Actions",
  "Brain Health",
  "Activity",
  "Settings",
];

export interface BrainPanelServices {
  brain: BrainDataService;
  operations: OperationService | null;
}

export interface BrainPanelOptions {
  /** Initial active tab (e.g. restored from the last overlay session). */
  initialTab?: SovereignTab;
  /** Called whenever the user switches tabs (so hosts can persist it). */
  onTabChanged?: (tab: SovereignTab) => void;
}

export class BrainPanel {
  private activeTab: SovereignTab = "Ask";
  private contextCard!: CurrentNoteContextCard;
  private tabContentEl!: HTMLElement;
  private navButtons: Map<SovereignTab, HTMLButtonElement> = new Map();
  private statusBarEl!: HTMLElement;
  private askComponent?: AskViewComponent;
  private statusRefreshTimer?: number;

  constructor(
    private rootEl: HTMLElement,
    private app: App,
    private services: BrainPanelServices,
    private options: BrainPanelOptions = {},
  ) {
    if (options.initialTab) this.activeTab = options.initialTab;
    this.build();
  }

  /** The currently displayed tab. */
  get currentTab(): SovereignTab {
    return this.activeTab;
  }

  private build(): void {
    const root = this.rootEl;
    root.empty();
    root.addClass("sovereign-panel-root");

    this.buildHeader(root);
    this.buildCurrentNoteContext(root);
    this.buildNavigationTabs(root);

    this.tabContentEl = root.createDiv({ cls: "sovereign-tab-content-area" });
    this.statusBarEl = root.createDiv({ cls: "sovereign-bottom-statusbar" });

    this.renderActiveTab();
    void this.updateStatusBar();

    // Keep the status bar honest while the panel is open: refresh on a slow
    // cadence rather than on every event (§91: never busy-wait).
    this.statusRefreshTimer = window.setInterval(() => {
      void this.updateStatusBar();
    }, 30_000);
  }

  /** Detach timers. The DOM lives with the host; nothing else to clean. */
  destroy(): void {
    if (this.statusRefreshTimer !== undefined) {
      window.clearInterval(this.statusRefreshTimer);
      this.statusRefreshTimer = undefined;
    }
  }

  private buildHeader(parentEl: HTMLElement): void {
    const header = parentEl.createDiv({ cls: "sovereign-global-header" });
    const titleRow = header.createDiv({ cls: "sovereign-title-row" });

    titleRow.createEl("span", {
      text: "SOVEREIGN BRAIN",
      cls: "sovereign-app-title",
    });

    // Permanent LOCAL ONLY status indicator badge.
    const badge = titleRow.createDiv({ cls: "sovereign-local-badge" });
    badge.createSpan({ text: "●", cls: "sovereign-dot-indicator" });
    badge.createSpan({ text: "LOCAL ONLY", cls: "sovereign-badge-text" });
  }

  private buildCurrentNoteContext(parentEl: HTMLElement): void {
    this.contextCard = new CurrentNoteContextCard(
      parentEl,
      this.app,
      this.services.brain,
      (noteTitle: string) => {
        this.switchTab("Ask");
        this.askComponent?.setQuery(`Explain key concepts and connections in [[${noteTitle}]]`);
      }
    );
  }

  private buildNavigationTabs(parentEl: HTMLElement): void {
    const navBar = parentEl.createDiv({ cls: "sovereign-nav-bar" });
    for (const tab of SOVEREIGN_TABS) {
      const btn = navBar.createEl("button", {
        text: tab,
        cls: `sovereign-nav-tab ${this.activeTab === tab ? "is-active" : ""}`,
      });
      btn.addEventListener("click", () => this.switchTab(tab));
      this.navButtons.set(tab, btn);
    }
  }

  public switchTab(tab: SovereignTab): void {
    if (this.activeTab === tab) return;
    this.activeTab = tab;

    this.navButtons.forEach((btn, t) => {
      if (t === tab) btn.addClass("is-active");
      else btn.removeClass("is-active");
    });

    this.renderActiveTab();
    this.options.onTabChanged?.(tab);
  }

  /** Focus the Ask input (overlay opens into a ready-to-type state). */
  focusAskInput(): void {
    if (this.activeTab === "Ask") {
      this.askComponent?.focusInput();
    } else {
      this.switchTab("Ask");
      // switchTab re-renders synchronously, so the input exists now.
      this.askComponent?.focusInput();
    }
  }

  private renderActiveTab(): void {
    this.tabContentEl.empty();

    switch (this.activeTab) {
      case "Ask":
        this.askComponent = new AskViewComponent(
          this.tabContentEl,
          this.app,
          this.services.brain,
          () => this.switchTab("Memory")
        );
        break;
      case "Memory":
        new MemoryViewComponent(
          this.tabContentEl,
          this.app,
          this.services.brain,
          () => void this.updateStatusBar()
        );
        break;
      case "Inbox":
        new InboxViewComponent(this.tabContentEl, this.app, this.services.brain, (tab) =>
          this.switchTab(tab as SovereignTab)
        );
        break;
      case "Actions":
        if (this.services.operations) {
          new ActionsViewComponent(
            this.tabContentEl,
            this.app,
            this.services.operations,
            () => void this.updateStatusBar()
          );
        } else {
          const empty = this.tabContentEl.createDiv({ cls: "sovereign-empty-state" });
          empty.createSpan({ text: "Operations require a running core." });
        }
        break;
      case "Brain Health":
        new BrainHealthComponent(this.tabContentEl, this.app, this.services.brain, (tab) =>
          this.switchTab(tab as SovereignTab)
        );
        break;
      case "Activity":
        new ActivityViewComponent(this.tabContentEl, this.app, this.services.brain);
        break;
      case "Settings":
        new SettingsViewComponent(this.tabContentEl, this.app, this.services.brain);
        break;
    }
  }

  private async updateStatusBar(): Promise<void> {
    if (!this.statusBarEl.isConnected) return;
    this.statusBarEl.empty();

    try {
      const { health, offline } = await this.services.brain.getHealthDetailed();

      if (offline) {
        this.statusBarEl.createSpan({
          text: "● core offline — start it in settings",
          cls: "sovereign-sb-label sovereign-text-warning",
        });
        return;
      }

      const stat1 = this.statusBarEl.createDiv({ cls: "sovereign-sb-item" });
      stat1.createSpan({ text: "Indexed: ", cls: "sovereign-sb-label" });
      stat1.createSpan({
        text: `${health.indexed_notes.toLocaleString()} notes`,
        cls: "sovereign-sb-val",
      });

      this.statusBarEl.createSpan({ text: "•", cls: "sovereign-sb-sep" });

      const stat2 = this.statusBarEl.createDiv({ cls: "sovereign-sb-item" });
      stat2.createSpan({ text: "Review: ", cls: "sovereign-sb-label" });
      stat2.createSpan({
        text: `${health.pending_memories}`,
        cls: `sovereign-sb-val ${health.pending_memories > 0 ? "sovereign-text-warning" : ""}`,
      });

      this.statusBarEl.createSpan({ text: "•", cls: "sovereign-sb-sep" });

      const stat3 = this.statusBarEl.createDiv({ cls: "sovereign-sb-item" });
      stat3.createSpan({ text: "Conflicts: ", cls: "sovereign-sb-label" });
      stat3.createSpan({
        text: `${health.potential_contradictions}`,
        cls: `sovereign-sb-val ${health.potential_contradictions > 0 ? "sovereign-text-warning" : ""}`,
      });
    } catch {
      this.statusBarEl.createSpan({
        text: "● status unavailable",
        cls: "sovereign-sb-label",
      });
    }
  }

  /** Refresh the context card for the given active file. */
  async refreshContext(file: TFile | null): Promise<void> {
    const path = file ? file.path : undefined;
    try {
      const context = await this.services.brain.getNoteContext(path);
      if (this.contextCard) this.contextCard.render(context);
    } catch {
      // Context card stays as-is on transient failures (§31).
    }
  }
}
