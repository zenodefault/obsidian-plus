import { ItemView, WorkspaceLeaf, TFile } from "obsidian";
import { RealBrainDataService, BrainDataService } from "../services/brainDataService";
import { OperationService } from "../services/operationService";
import { CurrentNoteContextCard } from "../components/CurrentNoteContextCard";
import { AskViewComponent } from "../components/AskViewComponent";
import { MemoryViewComponent } from "../components/MemoryViewComponent";
import { InboxViewComponent } from "../components/InboxViewComponent";
import { ActionsViewComponent } from "../components/ActionsViewComponent";
import { BrainHealthComponent } from "../components/BrainHealthComponent";
import { ActivityViewComponent } from "../components/ActivityViewComponent";
import { SettingsViewComponent } from "../components/SettingsViewComponent";

export const VIEW_TYPE_SOVEREIGN_SIDEBAR = "sovereign-sidebar-view";

export type SovereignTab =
  | "Ask"
  | "Memory"
  | "Inbox"
  | "Actions"
  | "Brain Health"
  | "Activity"
  | "Settings";

/** Provide the brain service from the plugin's daemon (wired in main.ts). */
export interface SidebarServices {
  brain: BrainDataService;
  operations: OperationService | null;
}

export class SovereignSidebarView extends ItemView {
  private activeTab: SovereignTab = "Ask";
  private contextCard!: CurrentNoteContextCard;
  private tabContentEl!: HTMLElement;
  private navButtons: Map<SovereignTab, HTMLButtonElement> = new Map();
  private statusBarEl!: HTMLElement;
  private askComponent?: AskViewComponent;
  private services: SidebarServices;

  constructor(leaf: WorkspaceLeaf, services?: SidebarServices) {
    super(leaf);
    this.services =
      services ??
      ({
        brain: new RealBrainDataService(() => null),
        operations: null,
      } satisfies SidebarServices);
  }

  getViewType(): string {
    return VIEW_TYPE_SOVEREIGN_SIDEBAR;
  }

  getDisplayText(): string {
    return "Sovereign Brain";
  }

  getIcon(): string {
    return "brain";
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("sovereign-sidebar-root");

    this.buildHeader(root);
    this.buildCurrentNoteContext(root);
    this.buildNavigationTabs(root);

    this.tabContentEl = root.createDiv({ cls: "sovereign-tab-content-area" });
    this.statusBarEl = root.createDiv({ cls: "sovereign-bottom-statusbar" });

    this.renderActiveTab();
    await this.updateStatusBar();

    // Listen to active note changes
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        void this.onActiveFileChanged(file);
      })
    );

    // Initial context load with current active file
    const activeFile = this.app.workspace.getActiveFile();
    void this.onActiveFileChanged(activeFile);
  }

  async onClose(): Promise<void> {
    // Teardown
  }

  private buildHeader(parentEl: HTMLElement): void {
    const header = parentEl.createDiv({ cls: "sovereign-global-header" });
    const titleRow = header.createDiv({ cls: "sovereign-title-row" });

    titleRow.createEl("span", {
      text: "SOVEREIGN BRAIN",
      cls: "sovereign-app-title",
    });

    // Permanent LOCAL ONLY status indicator badge
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
    const tabs: SovereignTab[] = [
      "Ask",
      "Memory",
      "Inbox",
      "Actions",
      "Brain Health",
      "Activity",
      "Settings",
    ];

    for (const tab of tabs) {
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

    this.statusBarEl.addEventListener("click", () => this.switchTab("Brain Health"));
  }

  private async onActiveFileChanged(file: TFile | null): Promise<void> {
    const path = file ? file.path : undefined;
    try {
      const context = await this.services.brain.getNoteContext(path);
      this.contextCard.render(context);
    } catch {
      // Context card stays as-is on transient failures (§31).
    }
  }
}
