/**
 * Vault inventory: converts Obsidian vault files into sync-note inventory
 * entries. The plugin is the only component that touches the vault (§89).
 */

import * as crypto from "node:crypto";
import type { TFile, Vault } from "obsidian";
import type { SyncNote } from "./types";

/** SHA-256 hex of a string — must match core/src/vault/manager.rs. */
export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/** Extensions eligible for indexing (markdown-first per §2). */
const INDEXABLE_EXTENSIONS = new Set(["md"]);

function shouldIndex(file: TFile): boolean {
  return INDEXABLE_EXTENSIONS.has(file.extension.toLowerCase());
}

/**
 * Build the full inventory of the vault: path, hash, mtime, size — no content.
 * Only markdown files are included; binaries and other formats are skipped.
 */
export async function buildInventory(vault: Vault, limit?: number): Promise<SyncNote[]> {
  const files = vault.getMarkdownFiles().filter(shouldIndex);
  const selected = limit !== undefined ? files.slice(0, limit) : files;
  const notes: SyncNote[] = [];
  for (const file of selected) {
    const content = await vault.cachedRead(file);
    notes.push({
      path: normalizePath(file.path),
      hash: hashContent(content),
      mtime: file.stat.mtime,
      size: file.stat.size,
    });
  }
  return notes;
}

/** Read one note with content for upload. */
export async function readNote(vault: Vault, path: string): Promise<SyncNote> {
  const file = vault.getAbstractFileByPath(path);
  if (!file || !("stat" in file)) {
    throw new Error(`note not found in vault: ${path}`);
  }
  const tfile = file as TFile;
  const content = await vault.read(tfile);
  return {
    path: normalizePath(tfile.path),
    hash: hashContent(content),
    mtime: tfile.stat.mtime,
    size: tfile.stat.size,
    content,
  };
}

/** Vault paths always use forward slashes. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

/**
 * Debouncer: collapses bursts of events into one trailing call (§37).
 * User typing produces many modify events; only the last matters.
 */
export class Debouncer {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly waitMs: number) {}

  /** Schedule `fn`; cancels any pending call. Returns true if it replaced one. */
  run(fn: () => void): boolean {
    const hadPending = this.timer !== null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      fn();
    }, this.waitMs);
    return hadPending;
  }

  /** Cancel any pending call without running it. */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  get pending(): boolean {
    return this.timer !== null;
  }
}
