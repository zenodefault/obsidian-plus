/**
 * Agent operations for the Actions tab (§59–66): preview → approve → execute
 * (version-checked) → apply through Obsidian → verify → audit. The plugin is
 * the only component that writes to the vault (§89); the core only proposes
 * and validates. Obsidian `Notice`s stay out of here for testability.
 */

import type { Vault, TFile } from "obsidian";
import {
  approveOperation,
  rejectOperation,
  executeOperation,
  verifyOperation,
  listOperations,
  rollbackOperation,
  applyInstructions,
} from "../vault/agent";
import type { AgentOperation } from "../vault/types";
import type { BrainClient } from "./brainDataService";
import { hashContent } from "../vault/inventory";

/** One diff line for the Actions preview. */
export interface DiffLineUi {
  type: "add" | "delete" | "context";
  text: string;
}

/** The Actions-tab view model for one operation. */
export interface OperationPreview {
  id: string;
  title: string;
  why: string;
  risk: "low" | "medium" | "high";
  status: "proposed" | "approved" | "rejected" | "applied";
  affected_files: string[];
  diffs: Array<{ file_path: string; diff_lines: DiffLineUi[] }>;
}

/** Read + hash helpers the vault bridge needs (seam for tests). */
export interface VaultBridge {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<boolean>;
  exists(path: string): boolean;
}

/** Bridge over the real Obsidian vault. */
export function obsidianVaultBridge(vault: Vault): VaultBridge {
  return {
    async read(path) {
      const file = vault.getAbstractFileByPath(path);
      if (!file || !("stat" in file)) return null;
      return vault.read(file as TFile);
    },
    async write(path, content) {
      const existing = vault.getAbstractFileByPath(path);
      if (existing && "stat" in existing) {
        await vault.modify(existing as TFile, content);
      } else {
        await vault.create(path, content);
      }
    },
    async remove(path) {
      const file = vault.getAbstractFileByPath(path);
      if (!file || !("stat" in file)) return false;
      await vault.delete(file as TFile);
      return true;
    },
    exists(path) {
      const file = vault.getAbstractFileByPath(path);
      return !!file && "stat" in file;
    },
  };
}

function mapStatus(op: AgentOperation): OperationPreview["status"] {
  if (op.status === "executed") return "applied";
  if (op.status === "rolled_back") return "applied";
  if (op.approval_status === "approved") return "approved";
  if (op.approval_status === "rejected") return "rejected";
  return "proposed";
}

/** Build a per-file unified-ish diff from old/new content (preview only). */
function buildDiff(oldContent: string | undefined, newContent: string | undefined): DiffLineUi[] {
  const lines: DiffLineUi[] = [];
  if (oldContent === undefined && newContent !== undefined) {
    for (const l of newContent.split("\n")) lines.push({ type: "add", text: `+ ${l}` });
    return lines;
  }
  const oldLines = (oldContent ?? "").split("\n");
  const newLines = (newContent ?? "").split("\n");
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max && lines.length < 40; i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o === n) {
      if (o !== undefined) lines.push({ type: "context", text: `  ${o}` });
      continue;
    }
    if (o !== undefined) lines.push({ type: "delete", text: `- ${o}` });
    if (n !== undefined) lines.push({ type: "add", text: `+ ${n}` });
  }
  return lines;
}

function toPreview(op: AgentOperation): OperationPreview {
  const diffs = op.files.map((f) => ({
    file_path: f.new_path ?? f.path,
    diff_lines: buildDiff(f.old_content, f.content),
  }));
  return {
    id: op.id,
    title: op.reason.length > 60 ? `${op.reason.slice(0, 60)}…` : op.reason,
    why: op.reason,
    risk: op.risk_level === "medium" ? "medium" : op.risk_level === "high" ? "high" : "low",
    status: mapStatus(op),
    affected_files: op.files.map((f) => f.new_path ?? f.path),
    diffs,
  };
}

export class OperationService {
  constructor(
    private client: () => BrainClient | null,
    private bridge: VaultBridge,
  ) {}

  private active(): BrainClient | null {
    const c = this.client();
    return c && c.getStatus() === "running" ? c : null;
  }

  /** Pending + recent operations, newest first. */
  async listPreviews(): Promise<OperationPreview[]> {
    const client = this.active();
    if (!client) return [];
    const ops = await listOperations(client, 20);
    return ops.map(toPreview);
  }

  /**
   * The §59 execution path: approve → version-checked execute → apply the
   * returned instructions through the vault bridge → verify hashes → done.
   * Throws typed RpcErrorImpl on permission/version failures; the vault is
   * only ever touched AFTER the core approved and verified the state.
   */
  async approveAndApply(id: string): Promise<{ applied: number; verified: string }> {
    const client = this.active();
    if (!client) throw new Error("core not running");
    await approveOperation(client, id);

    const op = await this.getOperation(id);
    const paths = op.files.map((f) => f.path);

    const { apply } = await executeOperation(
      client,
      id,
      paths,
      (p) => this.bridge.read(p),
      (c) => hashContent(c),
    );

    let applied = 0;
    const appliedHashes: Array<{ path: string; hash: string }> = [];
    for (const instr of applyInstructions(apply)) {
      if ("delete" in instr) {
        await this.bridge.remove(instr.path);
        continue;
      }
      await this.bridge.write(instr.path, instr.content);
      applied++;
      appliedHashes.push({ path: instr.path, hash: hashContent(instr.content) });
    }

    const message = await verifyOperation(client, id, appliedHashes);
    return { applied, verified: message };
  }

  async reject(id: string): Promise<void> {
    const client = this.active();
    if (!client) throw new Error("core not running");
    await rejectOperation(client, id);
  }

  /**
   * §65 rollback: the core verifies every file still matches the operation's
   * post-state (plugin attests), then returns reverse instructions which are
   * applied through the vault bridge. Never overwrites newer manual changes.
   */
  async rollback(id: string): Promise<{ reverted: number }> {
    const client = this.active();
    if (!client) throw new Error("core not running");
    const op = await this.getOperation(id);
    const checkPaths = op.files.map((f) => f.new_path ?? f.path);
    const { apply } = await rollbackOperation(
      client,
      id,
      checkPaths,
      (p) => this.bridge.read(p),
      (c) => hashContent(c),
    );
    let reverted = 0;
    for (const instr of applyInstructions(apply)) {
      if ("delete" in instr) {
        await this.bridge.remove(instr.path);
      } else {
        await this.bridge.write(instr.path, instr.content);
      }
      reverted++;
    }
    return { reverted };
  }

  private async getOperation(id: string): Promise<AgentOperation> {
    const client = this.client();
    if (!client) throw new Error("core not running");
    const { request } = client;
    const result = await request<{ operation: AgentOperation }>("operation.get", { id });
    return result.operation;
  }
}
