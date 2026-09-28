/**
 * Plugin settings (data plumbing only — the settings UI lives in
 * SettingTab.ts).
 *
 * The old `borderMotion` and `lastOverlayTab` fields died with the overlay
 * redesign: the popup is a single Ask surface (no tabs to remember) and the
 * border beam respects `prefers-reduced-motion` directly instead of a
 * separate toggle. What remains configurable is the beam's *appearance*
 * (size, colour preset, intensity) — the BorderBeam capability surface.
 * Residual keys in existing data.json files are ignored.
 */

import type { BeamColor, BeamSize } from "../ui/beam";

export interface SovereignBrainSettings {
  /** Absolute path to the sovereign-core binary; empty = auto-detect. */
  coreBinaryPath: string;
  /** Root directory for core state; empty = platform default. */
  dataDir: string;
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs: number;
  /** First-run wizard done? False makes it open on the next plugin load. */
  onboardingComplete: boolean;
  /** Auto-detect and link a local Ollama install (probes 127.0.0.1:11434). */
  ollamaAutoLink: boolean;
  /** Optional Ollama base URL override; empty = OLLAMA_HOST or the default. */
  ollamaBaseUrl: string;
  /** BorderBeam variant. */
  beamSize: BeamSize;
  /** BorderBeam colour preset; `theme` follows the Obsidian accent. */
  beamColor: BeamColor;
  /** BorderBeam intensity, 0 → 1. */
  beamStrength: number;
}

export const DEFAULT_SETTINGS: SovereignBrainSettings = {
  coreBinaryPath: "",
  dataDir: "",
  requestTimeoutMs: 15_000,
  onboardingComplete: false,
  ollamaAutoLink: true,
  ollamaBaseUrl: "",
  beamSize: "md",
  beamColor: "theme",
  beamStrength: 0.5,
};
