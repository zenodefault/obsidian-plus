import { App, Modal, Notice } from "obsidian";
import { ProposedOperation } from "../types/protocol";
import { mockService } from "../mock/mockData";

export class ActionApprovalModal extends Modal {
  constructor(
    app: App,
    private operation: ProposedOperation,
    private onDecision?: (status: "approved" | "rejected") => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sovereign-modal");

    contentEl.createEl("h3", { text: `Review Action: ${this.operation.title}` });

    const riskBox = contentEl.createDiv({ cls: "sovereign-card-header" });
    riskBox.createSpan({
      text: `${this.operation.risk.toUpperCase()} RISK`,
      cls: `sovereign-badge sovereign-badge-risk-${this.operation.risk}`,
    });

    const whyEl = contentEl.createEl("p", { cls: "sovereign-action-why" });
    whyEl.createSpan({ text: "Why: ", cls: "sovereign-text-bold" });
    whyEl.createSpan({ text: this.operation.why });

    // Diffs
    for (const diff of this.operation.diffs) {
      const diffBox = contentEl.createDiv({ cls: "sovereign-diff-box" });
      diffBox.createDiv({ text: diff.file_path, cls: "sovereign-diff-header" });
      const diffContent = diffBox.createDiv({ cls: "sovereign-diff-content" });
      for (const line of diff.diff_lines) {
        const lineEl = diffContent.createDiv({
          cls: `sovereign-diff-line sovereign-diff-${line.type}`,
        });
        lineEl.createSpan({ text: line.text });
      }
    }

    const btnRow = contentEl.createDiv({ cls: "sovereign-btn-group", attr: { style: "margin-top: 16px;" } });

    const approveBtn = btnRow.createEl("button", {
      text: "Approve & Execute",
      cls: "mod-cta sovereign-btn-sm",
    });
    approveBtn.addEventListener("click", async () => {
      await mockService.setOperationStatus(this.operation.id, "approved");
      new Notice(`Operation ${this.operation.title} approved.`);
      this.onDecision?.("approved");
      this.close();
    });

    const rejectBtn = btnRow.createEl("button", {
      text: "Reject",
      cls: "mod-warning sovereign-btn-sm",
    });
    rejectBtn.addEventListener("click", async () => {
      await mockService.setOperationStatus(this.operation.id, "rejected");
      new Notice(`Operation rejected.`);
      this.onDecision?.("rejected");
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
