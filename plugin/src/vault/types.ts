/**
 * Vault sync wire types (mirror of core/src/vault/types.rs).
 * Shared fixtures in schemas/protocol keep both sides aligned.
 */

/** One note as reported to the core. Content only on `vault.sync.note`. */
export interface SyncNote {
  path: string;
  hash: string;
  mtime: number;
  size: number;
  content?: string;
}

export interface SyncBeginResult {
  session_id: string;
  rebuild: boolean;
}

export type ChangeKind = "added" | "modified" | "renamed" | "deleted";

export interface RenamePair {
  from: string;
  to: string;
}

export interface SyncCommitResult {
  added: string[];
  modified: string[];
  renamed: RenamePair[];
  deleted: string[];
  to_fetch: string[];
  applied: number;
}

export interface SyncNoteResult {
  path: string;
  note_id: string;
  updated: boolean;
}

export interface SyncFinishResult {
  total_notes: number;
  persisted: boolean;
}

export interface StateNoteEntry {
  note_id: string;
  path: string;
  content_hash: string;
  title?: string;
  tags?: string[];
}

export interface StateGetResult {
  total_notes: number;
  notes: StateNoteEntry[];
}

export interface RebuildResult {
  cleared: boolean;
  message: string;
}
