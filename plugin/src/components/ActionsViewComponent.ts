import { App, Notice } from "obsidian";
import type { OperationPreview } from "../services/operationService";
import type { OperationService } from "../services/operationService";

export class ActionsViewComponent {
  private containerEl: HTMLElement;
  private listEl!: HTMLElement;

  constructor(
    parentEl: HTMLElement,
    private app: App,
    private operations: OperationService,
    private onActionCompleted?: () => void
  ) {
    this.containerEl = parentEl.createDiv({ cls: "sovereign-actions-view" });
    const header = this.containerEl.createDiv({ cls: "sovereign-view-header" });
    header.createEl("h4", { text: "Proposed Vault Actions" });
    header.createEl("p", {
      text: "The Sovereign Brain never mutates notes without explicit user review and permission.",
      cls: "sovereign-text-muted sovereign-text-xs",
    });

    this.listEl = this.containerEl.createDiv({ cls: "sovereign-actions-list" });
    void this.refresh();
  }

  async refresh(): Promise<void> {
    this.listEl.empty();
    let ops: OperationPreview[];
    try {
      ops = await this.operations.listPreviews();
    } catch (err) {
      new Notice(`Could not load operations: ${err instanceof Error ? err.message : String(err)}`);
      ops = [];
    }

    if (ops.length === 0) {
      const empty = this.listEl.createDiv({ cls: "sovereign-empty-state" });
      empty.createSpan({ text: "No pending actions requiring review." });
      return;
    }

    for (const op of ops) {
      this.renderOperationCard(op);
    }
  }

  private renderOperationCard(op: OperationPreview): void {
    const card = this.listEl.createDiv({ cls: "sovereign-card sovereign-action-card" });

    // Top Title & Risk
    const topRow = card.createDiv({ cls: "sovereign-card-header" });
    topRow.createSpan({ text: op.title, cls: "sovereign-card-title" });
    topRow.createSpan({
      text: `${op.risk.toUpperCase()} RISK`,
      cls: `sovereign-badge sovereign-badge-risk-${op.risk}`,
    });

    // Why section (§63 preview: WHY / WHAT / risk / files)
    const whyBox = card.createDiv({ cls: "sovereign-action-why" });
    whyBox.createSpan({ text: "WHY: ", cls: "sovereign-text-bold sovereign-text-xs" });
    whyBox.createSpan({ text: op.why, cls: "sovereign-text-muted" });

    // Affected files
    const affected = card.createDiv({ cls: "sovereign-action-files" });
    affected.createSpan({
      text: `Affected Files (${op.affected_files.length}): `,
      cls: "sovereign-text-bold sovereign-text-xs",
    });
    for (const f of op.affected_files) {
      const link = affected.createEl("a", { text: f, cls: "sovereign-chip" });
      link.addEventListener("click", () => {
        void this.app.workspace.openLinkText(f, "", false);
      });
    }

    // Diff preview
    for (const diff of op.diffs) {
      const diffContainer = card.createDiv({ cls: "sovereign-diff-box" });
      const diffHeader = diffContainer.createDiv({ cls: "sovereign-diff-header" });
      diffHeader.createSpan({ text: `diff -- ${diff.file_path}`, cls: "sovereign-diff-filename" });

      const diffContent = diffContainer.createDiv({ cls: "sovereign-diff-content" });
      for (const line of diff.diff_lines) {
        const lineEl = diffContent.createDiv({
          cls: `sovereign-diff-line sovereign-diff-${line.type}`,
        });
        lineEl.createSpan({ text: line.text });
      }
    }

    // Status + triggers (§63: approve/reject; §65: rollback after apply)
    const actionsRow = card.createDiv({ cls: "sovereign-card-footer" });
    actionsRow.createSpan({
      text: `Status: ${op.status.toUpperCase()}`,
      cls: "sovereign-text-muted sovereign-text-xs",
    });

    if (op.status === "proposed") {
      const btnGroup = actionsRow.createDiv({ cls: "sovereign-btn-group" });

      const approveBtn = btnGroup.createEl("button", {
        text: "Approve & Apply",
        cls: "mod-cta sovereign-btn-sm",
      });
      approveBtn.addEventListener("click", async () => {
        approveBtn.disabled = true;
        try {
          const { applied, verified } = await this.operations.approveAndApply(op.id);
          new Notice(`Applied ${applied} file change(s). Verification: ${verified}.`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          new Notice(`Apply failed — no partial changes were kept without verification: ${msg}`);
        }
        await this.refresh();
        this.onActionCompleted?.();
      });

      const rejectBtn = btnGroup.createEl("button", {
        text: "Reject",
        cls: "mod-warning sovereign-btn-sm",
      });
      rejectBtn.addEventListener("click", async () => {
        try {
          await this.operations.reject(op.id);
          new Notice("Operation rejected.");
        } catch (err) {
          new Notice(`Reject failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        await this.refresh();
        this.onActionCompleted?.();
      });
    } else if (op.status === "applied") {
      const btnGroup = actionsRow.createDiv({ cls: "sovereign-btn-group" });
      const rollbackBtn = btnGroup.createEl("button", {
        text: "↩ Rollback",
        cls: "sovereign-btn-sm sovereign-btn-secondary",
      });
      rollbackBtn.addEventListener("click", async () => {
        rollbackBtn.disabled = true;
        try {
          const { reverted } = await this.operations.rollback(op.id);
          new Notice(`Rolled back ${reverted} file change(s).`);
        } catch (err) {
          // Typically FILE_VERSION_CONFLICT: a file changed after the op.
          new Notice(`Rollback refused: ${err instanceof Error ? err.message : String(err)}`);
        }
        await this.refresh();
        this.onActionCompleted?.();
      });
    }
  }
}
