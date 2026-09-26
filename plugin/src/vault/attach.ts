/**
 * Vault event attachment (§37): watches create/modify/rename/delete and
 * triggers debounced incremental syncs. Never blocks; never touches content
 * directly — the sync orchestrator does.
 */

import type { TAbstractFile, TFile, Vault } from "obsidian";
import { Debouncer } from "./inventory";

export interface VaultWatcherDeps {
  /** Trigger an incremental sync (idempotent; implementations may coalesce). */
  scheduleSync: () => void;
  /** Called when the vault folder itself is renamed (full resync). */
  onStructuralChange?: () => void;
}

export interface VaultWatcher {
  watcher: (file: TAbstractFile, oldPath?: string) => void;
  debouncer: Debouncer;
}

/** Default debounce window: covers typical typing bursts. */
export const DEFAULT_DEBOUNCE_MS = 1_500;

/**
 * Build the event handler to register with `vault.on("modify" | ...)`.
 * Renames carry `oldPath`; batch imports collapse into one sync via debounce.
 */
export function createVaultWatcher(
  _vault: Vault,
  deps: VaultWatcherDeps,
  debounceMs: number = DEFAULT_DEBOUNCE_MS,
): VaultWatcher {
  const debouncer = new Debouncer(debounceMs);
  const watcher = (file: TAbstractFile, oldPath?: string) => {
    // Only markdown files matter for the brain (Part 2 scope).
    const isMarkdown = !("children" in file) && (file as TFile).extension !== undefined;
    if (!isMarkdown) return;

    if (oldPath !== undefined) {
      // Rename: schedule the normal incremental sync — rename detection in
      // the core handles identity transfer without re-uploading content.
      deps.scheduleSync();
      return;
    }
    debouncer.run(() => deps.scheduleSync());
  };
  return { watcher, debouncer };
}
