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

/** One search hit with citation provenance (§58). */
export interface SearchHit {
  note_id: string;
  note_path: string;
  chunk_id: string;
  heading_path: string;
  snippet: string;
  /** Higher is better. */
  score: number;
  /** Per-signal hybrid scores; absent on lexical-only fallback (§76). */
  score_breakdown?: {
    lexical: number;
    semantic: number;
    entity: number;
  };
}

export interface ModelStatus {
  provider: string;
  model_path?: string;
  binary_path?: string;
  dimension: number;
  chunks_total: number;
  chunks_embedded: number;
  chunks_pending: number;
  validation_error?: string;
}

// ---- Memory (§49–55) ----

export type MemoryStatus =
  | "candidate"
  | "accepted"
  | "rejected"
  | "superseded"
  | "stale"
  | "disputed";

export interface MemorySource {
  note_id?: string;
  note_path?: string;
  claim_id?: string;
  excerpt?: string;
}

export interface MemoryEntry {
  id: string;
  type: "goal" | "preference" | "decision" | "experience";
  content: string;
  status: MemoryStatus;
  confidence: number;
  user_verified: boolean;
  valid_from?: number;
  valid_until?: number;
  created_at: number;
  updated_at: number;
  sources: MemorySource[];
}

export interface ClaimRef {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  claim_type: string;
  polarity: number;
  note_path?: string;
}

export interface ContradictionEntry {
  id: string;
  kind: string;
  status: string;
  claim_a: ClaimRef;
  claim_b: ClaimRef;
  created_at: number;
}

// ---- Reasoning (§56–58) ----

export type QueryType =
  | "simple_search"
  | "semantic_search"
  | "synthesis"
  | "comparison"
  | "temporal"
  | "contradiction"
  | "decision"
  | "relationship"
  | "agent_task";

export interface AskSource {
  note_id: string;
  note_path: string;
  chunk_id: string;
  heading_path: string;
  snippet: string;
  score: number;
}

export interface AskResult {
  answer: string;
  query_type: QueryType;
  confidence: number;
  /** "model" | "evidence" | "agent" | "no_evidence" (§58, §76). */
  answer_mode: string;
  sources: AskSource[];
  memories: MemoryEntry[];
  contradictions: ContradictionEntry[];
}

// ---- Agent & safety (§59–66) ----

export type AgentFileAction = "create" | "edit" | "move";

export interface AgentFileInput {
  path: string;
  action: AgentFileAction;
  content?: string;
  old_content?: string;
  new_path?: string;
}

export interface AgentPlan {
  goal: string;
  files: AgentFileInput[];
  rationale: string[];
}

export interface AgentFile {
  path: string;
  action: string;
  note_id?: string;
  old_hash?: string;
  new_hash?: string;
  new_path?: string;
  content?: string;
  old_content?: string;
}

export interface AgentOperation {
  id: string;
  run_id?: string;
  reason: string;
  risk_level: string;
  approval_status: "pending" | "approved" | "rejected";
  status: "pending" | "executed" | "rolled_back" | "rejected";
  created_at: number;
  completed_at?: number;
  files: AgentFile[];
}

export interface ApplyFile {
  path: string;
  action: string;
  content?: string;
  new_path?: string;
}

export interface PathHash {
  path: string;
  hash: string;
}

export interface AuditEvent {
  id: string;
  operation_id?: string;
  actor: string;
  reason?: string;
  target?: string;
  approval?: string;
  result: string;
  previous_hash?: string;
  new_hash: string;
  created_at: number;
}

export interface AgentTool {
  name: string;
  permission: string;
  decision: "allow" | "confirm" | "denied";
  mutates: boolean;
}

export type ContradictionResolution = "keep_both" | "mark_later_current" | "ignore";

export interface SearchQueryResult {
  hits: SearchHit[];
  total_notes: number;
}
