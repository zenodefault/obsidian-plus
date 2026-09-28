/** Persistent Sovereign sidebar: overview + contextual knowledge observatory. */
import { ItemView, WorkspaceLeaf } from "obsidian";
import type SovereignSecondBrainPlugin from "../main";

export const VIEW_TYPE_SOVEREIGN_PANEL = "sovereign-panel";
type Observatory = "overview" | "timeline" | "constellation";

export class SovereignPanelView extends ItemView {
  private body!: HTMLElement;
  private mode: Observatory = "overview";
  constructor(leaf: WorkspaceLeaf, private plugin: SovereignSecondBrainPlugin) { super(leaf); }
  getViewType(): string { return VIEW_TYPE_SOVEREIGN_PANEL; }
  getDisplayText(): string { return "Sovereign"; }
  getIcon(): string { return "brain"; }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty(); root.addClass("sovereign-panel-root");
    const head = root.createDiv({ cls: "sovereign-panel-head" });
    head.createSpan({ text: "✦", cls: "sovereign-panel-mark" });
    head.createSpan({ text: "SOVEREIGN", cls: "sovereign-panel-title" });
    const ask = head.createEl("button", { text: "Ask", cls: "sovereign-panel-ask" });
    ask.addEventListener("click", () => this.plugin.askSovereign());
    const nav = root.createDiv({ cls: "sovereign-panel-nav" });
    this.navButton(nav, "Your brain", "overview");
    this.navButton(nav, "Timeline", "timeline");
    this.navButton(nav, "Constellation", "constellation");
    const map = nav.createEl("button", { text: "Knowledge map", cls: "sovereign-panel-nav-btn" });
    map.addEventListener("click", () => void this.plugin.openKnowledgeMap());
    this.body = root.createDiv({ cls: "sovereign-panel-body" });
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => void this.render()));
    this.registerEvent(this.app.metadataCache.on("resolved", () => void this.render()));
    await this.render();
  }
  private navButton(parent: HTMLElement, text: string, mode: Observatory): void {
    const button = parent.createEl("button", { text, cls: "sovereign-panel-nav-btn" });
    button.addEventListener("click", () => { this.mode = mode; void this.render(); });
  }
  private section(title: string): HTMLElement { return this.body.createDiv({ cls: "sovereign-panel-section" }).createDiv({ text: title, cls: "sovereign-panel-label" }).parentElement!; }
  private async render(): Promise<void> {
    if (!this.body?.isConnected) return;
    this.body.empty();
    if (this.mode === "timeline") return this.renderTimeline();
    if (this.mode === "constellation") return this.renderConstellation();
    const brain = this.plugin.brainData();
    const file = this.app.workspace.getActiveFile();
    const [{ health, offline }, context] = await Promise.all([brain.getHealthDetailed(), brain.getNoteContext(file?.path)]);
    if (!this.body.isConnected) return;
    const hero = this.body.createDiv({ cls: "sovereign-panel-overview" });
    hero.createDiv({ text: "YOUR BRAIN", cls: "sovereign-panel-label" });
    const stats = hero.createDiv({ cls: "sovereign-panel-stats" });
    [[health.indexed_notes, "Notes"], [health.pending_memories, "Memories to review"], [health.potential_contradictions, "Contradictions"]].forEach(([n, l]) => {
      const stat = stats.createDiv(); stat.createEl("strong", { text: String(n) }); stat.createSpan({ text: String(l) });
    });
    const current = this.section(file ? file.basename.toUpperCase() : "CURRENT CONTEXT");
    current.createDiv({ text: file ? "Sovereign is looking at the note you are editing." : "Open a note to see its local knowledge context.", cls: "sovereign-panel-muted" });
    for (const path of context.similar_notes) current.createEl("button", { text: path.split("/").pop()?.replace(/\.md$/i, "") ?? path, cls: "sovereign-panel-link" }).addEventListener("click", () => void this.app.workspace.openLinkText(path, "", false));
    const attention = this.section("ATTENTION");
    attention.createDiv({ text: `${context.related_notes_count} related notes · ${context.potential_connections_count} possible connections`, cls: "sovereign-panel-muted" });
    attention.createDiv({ text: context.contradictions_count ? `${context.contradictions_count} contradiction${context.contradictions_count === 1 ? "" : "s"} needs review` : "No contradictions detected for this context", cls: "sovereign-panel-muted" });
    const status = this.body.createDiv({ cls: "sovereign-panel-status" });
    status.setText(offline ? "● Core offline" : "● Synced locally");
  }
  private renderTimeline(): void {
    this.body.createDiv({ text: "KNOWLEDGE TIMELINE", cls: "sovereign-panel-label" });
    this.body.createDiv({ text: "Recent notes in your knowledge history", cls: "sovereign-panel-muted" });
    this.app.vault.getMarkdownFiles().sort((a, b) => b.stat.mtime - a.stat.mtime).slice(0, 10).forEach((file) => {
      const row = this.body.createEl("button", { cls: "sovereign-panel-timeline", text: `${new Date(file.stat.mtime).toLocaleDateString()}  ${file.basename}` });
      row.addEventListener("click", () => void this.app.workspace.openLinkText(file.path, "", false));
    });
  }
  private renderConstellation(): void {
    this.body.createDiv({ text: "KNOWLEDGE CONSTELLATION", cls: "sovereign-panel-label" });
    this.body.createDiv({ text: "Your strongest real topic clusters", cls: "sovereign-panel-muted" });
    const counts = new Map<string, number>();
    this.app.vault.getMarkdownFiles().forEach((file) => (this.app.metadataCache.getFileCache(file)?.tags ?? []).forEach((tag) => counts.set(tag.tag, (counts.get(tag.tag) ?? 0) + 1)));
    [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([tag, count]) => {
      const star = this.body.createDiv({ cls: "sovereign-panel-star" }); star.createSpan({ text: "✦" }); star.createSpan({ text: tag.replace(/^#/, "") }); star.createEl("small", { text: `${count} notes` });
    });
    const map = this.body.createEl("button", { text: "Explore on the knowledge map", cls: "sovereign-panel-explore" });
    map.addEventListener("click", () => void this.plugin.openKnowledgeMap());
  }
}
