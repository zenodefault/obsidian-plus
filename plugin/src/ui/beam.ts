/**
 * BorderBeam — the popup's one expressive element, implemented directly in the
 * existing DOM/CSS architecture.
 *
 * The React `border-beam` package cannot be consumed here without converting
 * the plugin to React, so this module reproduces its capability surface with
 * plain DOM + CSS custom properties (see the BorderBeam block in styles.css):
 *
 *   size:     md | sm | line | pulse-inner | pulse-outside
 *   color:    theme | colorful | mono | ocean | sunset
 *   strength: 0 → 1
 *   active:   boolean
 *   theme:    light | dark (resolved from Obsidian's own theme state)
 *
 * Everything here is declarative: it only sets data attributes, CSS variables
 * and one class. No timers, no rAF, no layout reads beyond one computed style
 * lookup for the theme fallback.
 */

export type BeamSize = "md" | "sm" | "line" | "pulse-inner" | "pulse-outside";
export type BeamColor = "theme" | "colorful" | "mono" | "ocean" | "sunset";
export type BeamTheme = "light" | "dark";

export const BEAM_SIZES: BeamSize[] = ["md", "sm", "line", "pulse-inner", "pulse-outside"];
export const BEAM_COLORS: BeamColor[] = ["theme", "colorful", "mono", "ocean", "sunset"];

export interface BeamOptions {
  /** Visual weight/variant of the beam. Default `md`. */
  size?: BeamSize;
  /** Colour preset; `theme` follows the active Obsidian accent. */
  color?: BeamColor;
  /** 0 → 1. Scales beam opacity and glow. Default 0.55. */
  strength?: number;
  /** When false the beam fades out entirely (kept for state machine parity). */
  active?: boolean;
}

/** Human labels for the settings UI. */
export const BEAM_SIZE_LABELS: Record<BeamSize, string> = {
  md: "Beam (medium arc)",
  sm: "Beam (short arc)",
  line: "Hairline (crisp)",
  "pulse-inner": "Pulse (inside)",
  "pulse-outside": "Pulse (outside glow)",
};

export const BEAM_COLOR_LABELS: Record<BeamColor, string> = {
  theme: "Theme accent",
  colorful: "Colourful",
  mono: "Monochrome",
  ocean: "Ocean",
  sunset: "Sunset",
};

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.55);

/** Parse `#rgb`, `#rrggbb`, `rgb()` / `rgba()`; null when unparseable. */
export function parseColor(raw: string): [number, number, number] | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(value);
  if (short) {
    return [
      parseInt(short[1]! + short[1]!, 16),
      parseInt(short[2]! + short[2]!, 16),
      parseInt(short[3]! + short[3]!, 16),
    ];
  }
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(value);
  if (long) {
    return [parseInt(long[1]!, 16), parseInt(long[2]!, 16), parseInt(long[3]!, 16)];
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(value);
  if (fn) {
    const parts = fn[1]!.split(",").map((p) => parseFloat(p));
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      return [parts[0]!, parts[1]!, parts[2]!];
    }
  }
  return null;
}

/** Perceptual luminance (0 → black, 1 → white) of a parsed colour. */
export function relativeLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/**
 * Theme of the host document. Obsidian puts `theme-dark` / `theme-light` on
 * `<body>`; if a theme renames those, fall back to the luminance of the
 * surface the beam rides on.
 */
export function detectBeamTheme(probe?: HTMLElement | null): BeamTheme {
  const body = typeof document === "undefined" ? null : document.body;
  if (body?.classList.contains("theme-light")) return "light";
  if (body?.classList.contains("theme-dark")) return "dark";
  const host = probe ?? body;
  if (!host || typeof getComputedStyle !== "function") return "dark";
  const styles = getComputedStyle(host);
  const surface = parseColor(styles.getPropertyValue("--background-primary"));
  const text = parseColor(styles.getPropertyValue("--text-normal"));
  const sample = surface ?? text;
  if (!sample) return "dark";
  return relativeLuminance(sample) > 0.5 ? "light" : "dark";
}

/** Apply the beam configuration to a `.sovereign-overlay-frame` element. */
export function applyBeam(el: HTMLElement, opts: BeamOptions = {}): void {
  el.dataset.beamSize = opts.size ?? "md";
  el.dataset.beamColor = opts.color ?? "theme";
  el.dataset.beamTheme = detectBeamTheme(el);
  el.dataset.beamActive = opts.active === false ? "false" : "true";
  el.style.setProperty("--sovereign-beam-strength", clamp01(opts.strength ?? 0.55).toFixed(2));
}
