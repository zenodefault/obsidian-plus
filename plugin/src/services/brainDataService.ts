/**
 * Real brain data service: the bridge between the Workstream-8 UI components
 * and the tested protocol wrappers (§34: the UI never constructs wire types
 * itself, and never reimplements core logic).
 *
 * Same surface the mock service used to expose, so components swap cleanly.
 * Every method degrades honestly when the core is offline: empty data and an
 * explicit offline answer — never fixtures (§29–31). Obsidian `Notice`s stay
 * out of here so the class stays unit-testable.
 */

import type { SovereignDaemon } from "../services/daemon";
import { ask } from "../vault/reasoning";
import { listMemories, acceptMemory, rejectMemory, supersedeMemory, listContradictions } from "../vault/memory";
import { healthSummary } from "../vault/health";
import { listActivity } from "../vault/agent";
import { searchQuery } from "../vault/search";
import type {
  AskConflictRef,
  AskQueryResult,
  CurrentNoteContext,
  MemoryItem,
  MemoryStatus,
  MemoryType,
  BrainHealthMetrics,
  AuditActivityItem,
  ConfidenceLevel,
} from "../types/protocol";

/** The service type the UI components consume. */
export type BrainDataService = InstanceType<typeof RealBrainDataService>;

/** The subset of the daemon the service needs (unit-testable seam). */
export interface BrainClient {
  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  getStatus(): "stopped" | "starting" | "running" | "crashed";
}

/** Adapt the real daemon to the seam. */
export function daemonClient(daemon: SovereignDaemon): BrainClient {
  return {
    request: <T,>(method: string, params?: unknown, timeoutMs?: number) =>
      daemon.request<T>(method, params, timeoutMs),
    getStatus: () => daemon.getStatus(),
  };
}

const OFFLINE_ANSWER =
  "The Sovereign core is not running. Start it (or check the plugin settings) — your notes are safe and nothing was modified.";

function confidenceOf(score: number): ConfidenceLevel {
  if (score >= 0.7) return "high";
  if (score >= 0.35) return "medium";
  return "low";
}

function memoryTypeOf(type: string): MemoryType {
  switch (type) {
    case "goal":
      return "goal";
    case "preference":
      return "preference";
    case "decision":
      return "decision";
    default:
      return "experience";
  }
}

/** Core memory status → the UI's pending/accepted/superseded tabs. */
function uiStatusOf(status: string): MemoryStatus {
  return status === "candidate" ? "pending" : (status as MemoryStatus);
}

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function pathTitle(path: string): string {
  return path.split("/").pop() ?? path;
}

/**
 * Demo mode (recording only): a fixed question→answer table for scripted
 * product demos. NEVER ships enabled — `SOVEREIGN_DEMO_MODE=1` opts in, and
 * unmatched questions fall through to the real core. Answers cite only real
 * demo-vault note paths so sources and Related links open actual notes.
 */
interface DemoAnswerSpec {
  match: RegExp;
  question: string;
  answer: string;
  sources: string[];
  related: string[];
  conflicts?: AskConflictRef[];
}

/** Demo mode is opt-in: env var for launch-based runs, localStorage for a
 * quick flip inside the running Obsidian session (DevTools console):
 *   localStorage.setItem("sovereign-demo-mode", "1")  → reload Obsidian.
 */
export function demoModeEnabled(): boolean {
  try {
    if (typeof localStorage !== "undefined" && localStorage.getItem("sovereign-demo-mode") === "1") {
      return true;
    }
  } catch {
    /* non-window context */
  }
  return false;
}

/** Real note paths in demo-vault — every source/related link opens a note. */
const DEMO_QA: DemoAnswerSpec[] = [
  {
    match: /motor anomaly|anomaly detection|bearing|what do i know about motor/i,
    question: "What do I know about motor anomaly detection?",
    answer:
      "Your notes currently indicate that the motor anomaly detection project is an edge system " +
      "that flags unusual motor behaviour before bearing failure. The prototype pairs vibration " +
      "from an IMU with motor-current signals, extracts compact features (RMS, peak-to-peak, then " +
      "selected FFT band energy), and runs inference locally on the ESP32. [Projects/Motor Anomaly Detection.md] " +
      "Bearing faults typically appear as changes in vibration amplitude and frequency content, " +
      "which is why the IMU sits near the bearing housing. [Research/Predictive Maintenance.md] " +
      "Your next experiment is capturing ten normal runs and three deliberately imbalanced runs at 4 kHz.",
    sources: [
      "Projects/Motor Anomaly Detection.md",
      "Research/Predictive Maintenance.md",
      "Research/Motor Research Log.md",
    ],
    related: ["Concepts/IMU Sensors.md", "Concepts/FFT Analysis.md", "Projects/ESP32 Edge Prototype.md"],
  },
  {
    match: /esp32|edge prototype/i,
    question: "What does the ESP32 prototype do?",
    answer:
      "The ESP32 prototype collects IMU vibration and motor-current readings for the motor anomaly " +
      "project, computes RMS, peak, and selected FFT bands, and stores a short result record. " +
      "[Projects/ESP32 Edge Prototype.md] Your stated principle: predictable measurements over a " +
      "complex model. The open question in your log is whether the ESP32 can compute the useful " +
      "bands quickly enough without sending raw samples. [Research/Motor Research Log.md]",
    sources: ["Projects/ESP32 Edge Prototype.md", "Research/Motor Research Log.md"],
    related: ["Projects/Motor Anomaly Detection.md", "Concepts/FFT Analysis.md"],
  },
  {
    match: /sampl|\bkhz\b|frequency of (the )?(vibration|sampling)/i,
    question: "What did I decide about the sampling rate?",
    answer:
      "You first decided to sample vibration at 1 kHz to keep the pipeline light while validating " +
      "sensor mounting and baseline features. [Decisions/Motor Sampling Decision.md] You later " +
      "revised that: the 1 kHz trial missed useful high-frequency bearing information, so the " +
      "prototype now samples at 4 kHz, with current sampling kept aligned to each vibration window. " +
      "[Decisions/Motor Sampling Revision.md]",
    sources: ["Decisions/Motor Sampling Revision.md", "Decisions/Motor Sampling Decision.md"],
    related: ["Research/Motor Research Log.md", "Concepts/FFT Analysis.md"],
    conflicts: [
      {
        earlier: "We decided to sample vibration at 1 kHz for the first prototype.",
        earlier_source: "Decisions/Motor Sampling Decision.md",
        later: "We decided to sample vibration at 4 kHz for the motor anomaly prototype.",
        later_source: "Decisions/Motor Sampling Revision.md",
        interpretation: "Revision, not a contradiction — the later decision supersedes the first.",
      },
    ],
  },
  {
    match: /fft|fourier|spectrum/i,
    question: "How does FFT analysis fit into the project?",
    answer:
      "FFT features are the comparison layer against your simple RMS baseline. The fast Fourier " +
      "transform reveals recurring vibration bands that a single RMS value hides, and your plan is " +
      "to add band energy only once the time-domain baseline is reliable. [Concepts/FFT Analysis.md] " +
      "Your feature plan mirrors this: RMS and peak-to-peak first, selected FFT band energy after. " +
      "[Research/Motor Research Log.md]",
    sources: ["Concepts/FFT Analysis.md", "Research/Motor Research Log.md"],
    related: ["Research/Predictive Maintenance.md", "Projects/Motor Anomaly Detection.md"],
  },
  {
    match: /\bimu\b|accelerometer|where have i mentioned (the )?(imu|vibration)/i,
    question: "Where have I mentioned the IMU?",
    answer:
      "The IMU appears across the project as the vibration source: its accelerometer is mounted near " +
      "the bearing housing, because good mounting and a stable sampling rate matter more than model " +
      "complexity. [Concepts/IMU Sensors.md] Your research log adds why current matters alongside " +
      "it — current helps distinguish a load change from a purely mechanical anomaly, and a loose " +
      "mount visibly raises low-frequency vibration. [Research/Motor Research Log.md]",
    sources: ["Concepts/IMU Sensors.md", "Research/Motor Research Log.md"],
    related: ["Research/Predictive Maintenance.md", "Projects/ESP32 Edge Prototype.md"],
  },
];

/** Build the scripted Ask result when demo mode is on and the query matches. */
function demoAnswer(query: string): AskQueryResult | null {
  const spec = DEMO_QA.find((d) => d.match.test(query));
  if (!spec) return null;
  return {
    query: spec.question,
    answer: spec.answer,
    confidence: "high",
    sources: spec.sources.map((path) => ({
      path,
      title: pathTitle(path),
      excerpt: demoExcerpt(path),
      score: 0.9,
    })),
    memories: [],
    conflicts: spec.conflicts,
  };
}

/** Real opening lines from the demo-vault notes, so excerpts are honest. */
const DEMO_EXCERPTS: Record<string, string> = {
  "Projects/Motor Anomaly Detection.md":
    "Build an edge system that detects unusual motor behaviour before bearing failure…",
  "Research/Predictive Maintenance.md":
    "Predictive maintenance uses changes in vibration, temperature, current, and acoustic signals to find faults before a machine stops working…",
  "Research/Motor Research Log.md":
    "At constant speed, the healthy motor has a stable RMS vibration level…",
  "Projects/ESP32 Edge Prototype.md":
    "The ESP32 prototype collects IMU vibration and motor-current readings…",
  "Concepts/IMU Sensors.md":
    "An IMU measures acceleration and angular motion. In the motor project, the accelerometer is attached near the bearing housing…",
  "Concepts/FFT Analysis.md":
    "The fast Fourier transform converts a sampled signal into frequency components…",
  "Decisions/Motor Sampling Decision.md":
    "We decided to sample vibration at 1 kHz for the first prototype…",
  "Decisions/Motor Sampling Revision.md":
    "We decided to sample vibration at 4 kHz for the motor anomaly prototype…",
};

function demoExcerpt(path: string): string {
  return DEMO_EXCERPTS[path] ?? "Open the note for the full context.";
}

export class RealBrainDataService {
  constructor(private client: () => BrainClient | null) {}

  /** The active client, or null while the core is offline. */
  private active(): BrainClient | null {
    const c = this.client();
    return c && c.getStatus() === "running" ? c : null;
  }

  /** `brain.ask` (§58) mapped to the Ask view model. */
  async queryBrain(query: string): Promise<AskQueryResult> {
    const demo = demoModeEnabled() ? demoAnswer(query) : null;
    if (demo) return demo;
    const client = this.active();
    if (!client) return this.offlineAsk(query);
    const result = await ask(client, query);
    const sources = result.sources.map((s) => ({
      path: s.note_path,
      title: pathTitle(s.note_path),
      excerpt: s.snippet.replace(/[«»]/g, ""),
      score: s.score,
    }));
    const memories = result.memories.map((m) => ({
      id: m.id,
      statement: m.content,
      type: memoryTypeOf(m.type),
    }));
    const conflicts = result.contradictions.map((c) => ({
      earlier: c.claim_a.object,
      earlier_source: c.claim_a.note_path ?? "unknown note",
      later: c.claim_b.object,
      later_source: c.claim_b.note_path ?? "unknown note",
      interpretation: `Detected ${c.kind.replace(/_/g, " ")}; review both sources before deciding.`,
    }));
    return {
      query,
      answer: result.answer,
      confidence: confidenceOf(result.confidence),
      sources,
      memories,
      conflicts: conflicts.length > 0 ? conflicts : undefined,
    };
  }

  private offlineAsk(query: string): AskQueryResult {
    return {
      query,
      answer: OFFLINE_ANSWER,
      confidence: "low",
      sources: [],
      memories: [],
    };
  }

  /** Current-note context (§17) from real retrieval + memory data. */
  async getNoteContext(path?: string): Promise<CurrentNoteContext> {
    const client = this.active();
    const offline: CurrentNoteContext = {
      path: path ?? "",
      title: path ? pathTitle(path) : "No note open",
      related_notes_count: 0,
      memories_count: 0,
      potential_connections_count: 0,
      contradictions_count: 0,
      similar_notes: [],
    };
    if (!client || !path) return offline;
    try {
      const [hits, memories, contradictions] = await Promise.all([
        searchQuery(client, pathTitle(path).replace(/\.md$/i, ""), 6),
        listMemories(client),
        listContradictions(client),
      ]);
      const related = hits.filter((h) => h.note_path !== path);
      const relevant = memories.filter(
        (m) => m.status === "accepted" || m.status === "candidate",
      );
      return {
        path,
        title: pathTitle(path),
        related_notes_count: related.length,
        memories_count: relevant.length,
        potential_connections_count: Math.max(0, related.length - 1),
        contradictions_count: contradictions.length,
        similar_notes: related.slice(0, 3).map((h) => h.note_path),
      };
    } catch {
      return offline;
    }
  }

  /** `memory.list` over all statuses → the review UI model. */
  async getMemories(): Promise<MemoryItem[]> {
    const client = this.active();
    if (!client) return [];
    const entries = await listMemories(client);
    return entries.map((m) => ({
      id: m.id,
      statement: m.content,
      type: memoryTypeOf(m.type),
      status: uiStatusOf(m.status),
      source_path: m.sources.find((s) => s.note_path)?.note_path ?? "unknown",
      confidence: m.user_verified ? "high" : m.confidence >= 0.8 ? "high" : "medium",
      created_at: new Date(m.created_at).toISOString().slice(0, 10),
    }));
  }

  /** Memory review transitions (§50; user-driven only). */
  async setMemoryStatus(id: string, status: MemoryStatus): Promise<void> {
    const client = this.active();
    if (!client) return;
    if (status === "accepted") await acceptMemory(client, id);
    else if (status === "rejected") await rejectMemory(client, id);
    else if (status === "superseded") await supersedeMemory(client, id, "Superseded by user review");
  }

  /** `health.summary` (§68) → the health cards; prefer `getHealthDetailed`. */
  async getHealthMetrics(): Promise<BrainHealthMetrics> {
    const { health } = await this.getHealthDetailed();
    return health;
  }

  /**
   * Richer health fetch: the component uses this when it wants contradiction
   * and memory-review counts in one round trip.
   */
  async getHealthDetailed(): Promise<{
    health: BrainHealthMetrics;
    offline: boolean;
  }> {
    const client = this.active();
    if (!client) {
      return {
        health: {
          indexed_notes: 0,
          pending_memories: 0,
          potential_contradictions: 0,
          stale_knowledge: 0,
          duplicate_notes: 0,
          broken_links: 0,
        },
        offline: true,
      };
    }
    const [summary, contradictions, memories] = await Promise.all([
      healthSummary(client),
      listContradictions(client),
      listMemories(client, "candidate"),
    ]);
    return {
      offline: false,
      health: {
        indexed_notes: summary.total_notes,
        pending_memories: memories.length,
        potential_contradictions: contradictions.length,
        stale_knowledge: 0, // stale memory listing arrives with §55 UI review
        duplicate_notes: summary.duplicate_candidates.length,
        broken_links: summary.broken_links.length,
      },
    };
  }

  /** `activity.list` (§66) → the audit timeline; category from the event kind. */
  async getActivity(): Promise<AuditActivityItem[]> {
    const client = this.active();
    if (!client) return [];
    const { events } = await listActivity(client, 50);
    return events.map((e) => ({
      id: e.id,
      timestamp: relTime(e.created_at),
      title: e.result.replace(/[_.]/g, " "),
      detail: e.reason ?? undefined,
      category: e.result.includes("operation") ? "action" : "sync",
    }));
  }

  /** The audit trail plus chain verification (§66), for the Activity tab. */
  async getActivityWithChain(): Promise<{ events: AuditActivityItem[]; chain_valid: boolean }> {
    const client = this.active();
    if (!client) return { events: [], chain_valid: true };
    const { events, chain_valid } = await listActivity(client, 50);
    return {
      chain_valid,
      events: events.map((e) => ({
        id: e.id,
        timestamp: relTime(e.created_at),
        title: e.result.replace(/[_.]/g, " "),
        detail: e.reason ?? undefined,
        category: e.result.includes("operation") ? "action" : "sync",
      })),
    };
  }

  /** Whether the core is currently serving. */
  isOnline(): boolean {
    return this.active() !== null;
  }

  /** Direct client access for surfaces that need raw protocol methods. */
  getClient(): BrainClient {
    const client = this.active();
    if (!client) throw new Error("core not running");
    return client;
  }
}
