/**
 * Plugin settings (data plumbing only — the settings UI is out of scope for
 * this part). Paths are configurable per PLAN.md §8.
 */

export interface SovereignBrainSettings {
  /** Absolute path to the sovereign-core binary; empty = auto-detect. */
  coreBinaryPath: string;
  /** Root directory for core state; empty = platform default. */
  dataDir: string;
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs: number;
}

export const DEFAULT_SETTINGS: SovereignBrainSettings = {
  coreBinaryPath: "",
  dataDir: "",
  requestTimeoutMs: 15_000,
};
