import {
  AskQueryResult,
  CurrentNoteContext,
  MemoryItem,
  MemoryStatus,
  ProposedOperation,
  OperationStatus,
  BrainHealthMetrics,
  AuditActivityItem,
  PrivacyStatus,
} from "../types/protocol";

export const MOCK_ASK_RESULT: AskQueryResult = {
  query: "What are our architectural principles for Sovereign Second Brain?",
  answer:
    "The system strictly prioritizes local execution, zero-cloud dependency, and immutable user note boundaries. All vector and relational state is stored locally, and the core acts as an advisory intelligence layer without mutating markdown without explicit permission.",
  confidence: "high",
  sources: [
    {
      path: "Architecture/Principles.md",
      title: "Principles.md",
      excerpt: "Zero remote LLM APIs, zero telemetry, local-first intelligence. Markdown remains source of truth.",
      score: 0.94,
    },
    {
      path: "Specs/ZeroCloud.md",
      title: "ZeroCloud.md",
      excerpt: "No network sockets. The core never listens, never connects out.",
      score: 0.89,
    },
  ],
  memories: [
    {
      id: "mem-accepted-1",
      statement: "Prefers local-first software and absolute data sovereignty.",
      type: "preference",
    },
  ],
  conflicts: [
    {
      earlier: "Use external cloud embeddings for scale.",
      earlier_source: "Notes/InitialBrainstorm.md (Jan 2026)",
      later: "Strict zero-cloud local embeddings only.",
      later_source: "Specs/ZeroCloud.md (Aug 2026)",
      interpretation: "Evolved architectural direction towards complete local privacy.",
    },
  ],
};

export const MOCK_CURRENT_NOTE_CONTEXT: CurrentNoteContext = {
  path: "Projects/SovereignBrain.md",
  title: "SovereignBrain.md",
  related_notes_count: 12,
  memories_count: 4,
  potential_connections_count: 6,
  contradictions_count: 1,
  similar_notes: [
    "Architecture/Principles.md",
    "Specs/ZeroCloud.md",
    "Ideas/LocalAI.md",
  ],
};

export const MOCK_MEMORIES: MemoryItem[] = [
  {
    id: "mem-1",
    statement: "Master distributed systems and local vector databases",
    type: "goal",
    status: "pending",
    source_path: "Career/Goals.md",
    confidence: "high",
    created_at: "2026-09-24",
    related_topics: ["Career", "Distributed Systems"],
  },
  {
    id: "mem-2",
    statement: "Markdown files must remain standard CommonMark with no proprietary syntax",
    type: "preference",
    status: "pending",
    source_path: "Notes/DesignStandards.md",
    confidence: "high",
    created_at: "2026-09-25",
    related_topics: ["Markdown", "Format"],
  },
  {
    id: "mem-3",
    statement: "Reject all remote telemetry and cloud sync services",
    type: "decision",
    status: "accepted",
    source_path: "Decisions/Privacy.md",
    confidence: "high",
    created_at: "2026-09-20",
    related_topics: ["Privacy", "Security"],
  },
  {
    id: "mem-4",
    statement: "Use cloud LLM API endpoint for query processing",
    type: "preference",
    status: "superseded",
    source_path: "Archived/OldSetup.md",
    confidence: "low",
    created_at: "2026-01-15",
    related_topics: ["Archived"],
  },
];

export const MOCK_PROPOSED_OPERATIONS: ProposedOperation[] = [
  {
    id: "op-1",
    title: "Organize Knowledge Pipeline & Link Local Vectors",
    why: "Detected unlinked concepts in Research/Pipeline.md pointing to newly established Sovereign principles.",
    risk: "low",
    status: "proposed",
    affected_files: ["Research/Pipeline.md"],
    diffs: [
      {
        file_path: "Research/Pipeline.md",
        diff_lines: [
          { type: "context", text: "## Knowledge Retrieval Pipeline" },
          { type: "delete", text: "- Query remote vector index endpoint for similarity rankings." },
          { type: "add", text: "+ Query local embedded vector store for instant, private similarity rankings." },
          { type: "context", text: "Results are streamed back to the plugin via stdio NDJSON." },
        ],
      },
    ],
  },
];

export const MOCK_BRAIN_HEALTH: BrainHealthMetrics = {
  indexed_notes: 2431,
  pending_memories: 2,
  potential_contradictions: 1,
  stale_knowledge: 4,
  duplicate_notes: 2,
  broken_links: 0,
};

export const MOCK_AUDIT_ACTIVITY: AuditActivityItem[] = [
  {
    id: "act-1",
    timestamp: "10m ago",
    title: "Action #182 approved",
    detail: "Updated 1 file (Research/Pipeline.md)",
    category: "action",
  },
  {
    id: "act-2",
    timestamp: "1h ago",
    title: "Incremental sync complete",
    detail: "Indexed 14 modified notes",
    category: "sync",
  },
];

export const MOCK_PRIVACY_STATUS: PrivacyStatus = {
  network_access: "OFF",
  cloud_apis: "NONE",
  telemetry: "NONE",
  remote_processing: "NONE",
  local_processing: "ENABLED",
};

/** Stateful Mock Service for UI Development */
class MockDataService {
  private memories = [...MOCK_MEMORIES];
  private operations = [...MOCK_PROPOSED_OPERATIONS];
  private health = { ...MOCK_BRAIN_HEALTH };
  private activities = [...MOCK_AUDIT_ACTIVITY];

  async queryAsk(_query: string): Promise<AskQueryResult> {
    return { ...MOCK_ASK_RESULT, query: _query };
  }

  async getNoteContext(path?: string): Promise<CurrentNoteContext> {
    return {
      ...MOCK_CURRENT_NOTE_CONTEXT,
      path: path ?? MOCK_CURRENT_NOTE_CONTEXT.path,
      title: path ? path.split("/").pop() ?? path : MOCK_CURRENT_NOTE_CONTEXT.title,
    };
  }

  async getMemories(): Promise<MemoryItem[]> {
    return [...this.memories];
  }

  async setMemoryStatus(id: string, status: MemoryStatus): Promise<void> {
    const item = this.memories.find((m) => m.id === id);
    if (item) {
      item.status = status;
      if (status === "accepted" && this.health.pending_memories > 0) {
        this.health.pending_memories--;
      }
      this.activities.unshift({
        id: `act-${Date.now()}`,
        timestamp: "Just now",
        title: `Memory ${status}`,
        detail: item.statement.slice(0, 40) + "...",
        category: "memory",
      });
    }
  }

  async getOperations(): Promise<ProposedOperation[]> {
    return [...this.operations];
  }

  async setOperationStatus(id: string, status: OperationStatus): Promise<void> {
    const op = this.operations.find((o) => o.id === id);
    if (op) {
      op.status = status;
      this.activities.unshift({
        id: `act-${Date.now()}`,
        timestamp: "Just now",
        title: `Operation ${status}: ${op.title}`,
        detail: `${op.affected_files.length} file(s) affected`,
        category: "action",
      });
    }
  }

  async getHealthMetrics(): Promise<BrainHealthMetrics> {
    return { ...this.health };
  }

  async getActivity(): Promise<AuditActivityItem[]> {
    return [...this.activities];
  }

  async getPrivacyStatus(): Promise<PrivacyStatus> {
    return { ...MOCK_PRIVACY_STATUS };
  }
}

export const mockService = new MockDataService();
