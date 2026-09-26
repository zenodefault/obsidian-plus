/**
 * Sync orchestrator: owns the full begin → batch → commit → note → finish
 * conversation with the core (docs/protocol.md, Part 2 flow).
 *
 * Chunks large inventories, uploads only what the core requests, and reports
 * progress without exposing note content (§97).
 */

import type { SyncCommitResult, SyncNote } from "./types";

/** Default inventory chunk size per `vault.sync.batch` call. */
export const BATCH_SIZE = 200;

export interface SyncNoteResult {
  path: string;
  note_id: string;
  updated: boolean;
}

export interface SyncRunnerDeps {
  begin: (rebuild: boolean) => Promise<{ session_id: string; rebuild: boolean }>;
  batch: (sessionId: string, notes: SyncNote[]) => Promise<{ received: number }>;
  commit: (sessionId: string) => Promise<SyncCommitResult>;
  /** Fetch one note's full content from the vault. */
  readNote: (path: string) => Promise<SyncNote>;
  uploadNote: (sessionId: string, note: SyncNote) => Promise<SyncNoteResult>;
  finish: (sessionId: string) => Promise<{ total_notes: number; persisted: boolean }>;
}

export interface SyncOutcome extends SyncCommitResult {
  totalNotes: number;
  persisted: boolean;
  uploaded: number;
}

export class SyncAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncAbortedError";
  }
}

/**
 * Run one complete sync session over the given inventory.
 * `shouldAbort` is polled between steps so callers can cancel cleanly
 * (e.g. on unload or when a newer sync supersedes this one).
 */
export async function runSync(
  deps: SyncRunnerDeps,
  inventory: SyncNote[],
  opts: {
    rebuild?: boolean;
    shouldAbort?: () => boolean;
    onProgress?: (stage: string, done: number, total: number) => void;
  } = {},
): Promise<SyncOutcome> {
  const { rebuild = false, shouldAbort, onProgress } = opts;
  const check = () => {
    if (shouldAbort?.()) throw new SyncAbortedError("sync aborted");
  };

  // 1. Open the session.
  const begun = await deps.begin(rebuild);
  const session = begun.session_id;

  // 2. Send the inventory in batches (hashes only — no content yet).
  let received = 0;
  for (let i = 0; i < inventory.length; i += BATCH_SIZE) {
    check();
    const chunk = inventory.slice(i, i + BATCH_SIZE);
    const r = await deps.batch(session, chunk);
    received += r.received;
  }
  onProgress?.("inventory", received, inventory.length);

  // 3. Commit: core diffs and decides what content it needs.
  check();
  const diff = await deps.commit(session);
  onProgress?.("committed", diff.to_fetch.length, diff.to_fetch.length);

  // 4. Upload exactly what the core requested.
  let uploaded = 0;
  for (const path of diff.to_fetch) {
    check();
    const note = await deps.readNote(path);
    await deps.uploadNote(session, note);
    uploaded += 1;
    onProgress?.("uploading", uploaded, diff.to_fetch.length);
  }

  // 5. Finish and persist.
  check();
  const fin = await deps.finish(session);
  return {
    added: diff.added,
    modified: diff.modified,
    renamed: diff.renamed,
    deleted: diff.deleted,
    to_fetch: diff.to_fetch,
    applied: diff.applied,
    totalNotes: fin.total_notes,
    persisted: fin.persisted,
    uploaded,
  };
}

/**
 * Split an inventory into batches and send them.
 * Kept exported for callers that drive sessions manually (tests, tools).
 */
export async function sendInventoryBatches(
  batch: (sessionId: string, notes: SyncNote[]) => Promise<{ received: number }>,
  sessionId: string,
  notes: SyncNote[],
  shouldAbort?: () => boolean,
): Promise<number> {
  let received = 0;
  for (let i = 0; i < notes.length; i += BATCH_SIZE) {
    if (shouldAbort?.()) throw new SyncAbortedError("sync aborted");
    const chunk = notes.slice(i, i + BATCH_SIZE);
    const r = await batch(sessionId, chunk);
    received += r.received;
  }
  return received;
}
