import { ItemView, WorkspaceLeaf, TFile } from "obsidian";
import { mockService } from "../mock/mockData";
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

export class SovereignSidebarView extends ItemView {
  private activeTab: SovereignTab = "Ask";
  private contextCard!: CurrentNoteContextCard;
  private tabContentEl!: HTMLElement;
  private navButtons: Map<SovereignTab, HTMLButtonElement> = new Map();
  private statusBarEl!: HTMLElement;
  private askComponent?: AskViewComponent;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
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
          () => this.switchTab("Memory")
        );
        break;
      case "Memory":
        new MemoryViewComponent(
          this.tabContentEl,
          this.app,
          () => void this.updateStatusBar()
        );
        break;
      case "Inbox":
        new InboxViewComponent(this.tabContentEl, this.app, (tab) =>
          this.switchTab(tab as SovereignTab)
        );
        break;
      case "Actions":
        new ActionsViewComponent(
          this.tabContentEl,
          this.app,
          () => void this.updateStatusBar()
        );
        break;
      case "Brain Health":
        new BrainHealthComponent(this.tabContentEl, this.app, (tab) =>
          this.switchTab(tab as SovereignTab)
        );
        break;
      case "Activity":
        new ActivityViewComponent(this.tabContentEl, this.app);
        break;
      case "Settings":
        new SettingsViewComponent(this.tabContentEl, this.app);
        break;
    }
  }

  private async updateStatusBar(): Promise<void> {
    this.statusBarEl.empty();
    const health = await mockService.getHealthMetrics();

    const stat1 = this.statusBarEl.createDiv({ cls: "sovereign-sb-item" });
    stat1.createSpan({ text: "Indexed: ", cls: "sovereign-sb-label" });
    stat1.createSpan({ text: `${health.indexed_notes.toLocaleString()} notes`, cls: "sovereign-sb-val" });

    this.statusBarEl.createSpan({ text: "•", cls: "sovereign-sb-sep" });

    const stat2 = this.statusBarEl.createDiv({ cls: "sovereign-sb-item" });
    stat2.createSpan({ text: "Memories: ", cls: "sovereign-sb-label" });
    stat2.createSpan({ text: `83`, cls: "sovereign-sb-val" });

    this.statusBarEl.createSpan({ text: "•", cls: "sovereign-sb-sep" });

    const stat3 = this.statusBarEl.createDiv({ cls: "sovereign-sb-item" });
    stat3.createSpan({ text: "Review: ", cls: "sovereign-sb-label" });
    stat3.createSpan({
      text: `${health.pending_memories}`,
      cls: `sovereign-sb-val ${health.pending_memories > 0 ? "sovereign-text-warning" : ""}`,
    });

    this.statusBarEl.addEventListener("click", () => this.switchTab("Brain Health"));
  }

  private async onActiveFileChanged(file: TFile | null): Promise<void> {
    const path = file ? file.path : undefined;
    const context = await mockService.getNoteContext(path);
    this.contextCard.render(context);
  }
}
