/**
 * Plugin settings (data plumbing only — the settings UI lives in
 * SettingTab.ts). Paths are configurable per PLAN.md §8.
 */

import type { SovereignTab } from "../components/BrainPanel";

export interface SovereignBrainSettings {
  /** Absolute path to the sovereign-core binary; empty = auto-detect. */
  coreBinaryPath: string;
  /** Root directory for core state; empty = platform default. */
  dataDir: string;
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs: number;
  /** First-run wizard done? False makes it open on the next plugin load. */
  onboardingComplete: boolean;
  /** Animated border trace on the overlay (off also honors reduced motion). */
  borderMotion: boolean;
  /** Last tab the user had open in the overlay (restored on reopen). */
  lastOverlayTab: SovereignTab;
}

export const DEFAULT_SETTINGS: SovereignBrainSettings = {
  coreBinaryPath: "",
  dataDir: "",
  requestTimeoutMs: 15_000,
  onboardingComplete: false,
  borderMotion: true,
  lastOverlayTab: "Ask",
};
