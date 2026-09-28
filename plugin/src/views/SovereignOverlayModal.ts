/**
 * SovereignOverlayModal — the hotkey popup. A centered floating surface for
 * asking the second brain one question at a time, framed by a BorderBeam-style
 * light that rides the perimeter (quiet when idle, brighter while thinking).
 *
 * This is NOT a mini-application: no tabs, no dashboards, no status bar. The
 * old tabbed BrainPanel composition is gone from the popup — the modal hosts
 * `BrainAskSurface` (the shared Ask flow) and nothing else.
 *
 * The beam is the one expressive element here and it is fully configurable
 * (size / colour preset / intensity / active) via `src/ui/beam.ts`:
 * - colours default to the active Obsidian accent — blue is never forced;
 * - the beam re-resolves its light/dark treatment on theme change;
 * - `prefers-reduced-motion` collapses it to a static ring (CSS only).
 */

import { App, Modal, type EventRef } from "obsidian";
import { BrainAskSurface } from "./../components/BrainAskSurface";
import type { AskContext, RelatedProvider } from "../components/AskViewComponent";
import type { BrainDataService } from "../services/brainDataService";
import { applyBeam, type BeamOptions } from "../ui/beam";

export interface SovereignOverlayServices {
  brain: BrainDataService;
  /** BorderBeam configuration (from plugin settings). */
  beam?: BeamOptions;
  /** Real related-note lookup built from the vault's own link graph. */
  related?: RelatedProvider;
}

/** Real editor context the popup was opened from (never inferred). */
export type OverlayContext = AskContext;

export interface SovereignOverlayOptions {
  /** Open already asking this exact question (graph → "Ask Sovereign"). */
  query?: string;
  /** Where the user was; handed to the answer surface as context. */
  context?: OverlayContext;
  /** Per-open beam override (defaults come from settings). */
  beam?: BeamOptions;
}

export class SovereignOverlayModal extends Modal {
  private surface: BrainAskSurface | null = null;
  private frame: HTMLElement | null = null;
  private beamOptions: BeamOptions;
  private cssRef: EventRef | null = null;

  constructor(
    app: App,
    private services: SovereignOverlayServices,
    private options: SovereignOverlayOptions = {},
  ) {
    super(app);
    this.beamOptions = { ...services.beam, ...options.beam };
  }

  async onOpen(): Promise<void> {
    const { contentEl, modalEl } = this;
    contentEl.empty();
    modalEl.addClass("sovereign-overlay-modal");

    // The frame carries the border beam; the ask surface sits inside it.
    const frame = contentEl.createDiv({ cls: "sovereign-overlay-frame" });
    frame.createDiv({ cls: "sovereign-beam-layer" });
    this.frame = frame;
    applyBeam(frame, this.beamOptions);

    // Theme changes are live: the beam re-resolves light/dark treatment.
    this.cssRef = this.app.workspace.on("css-change", () => {
      if (this.frame) applyBeam(this.frame, this.beamOptions);
    });

    const surfaceHost = frame.createDiv({ cls: "sovereign-overlay-body" });
    this.surface = new BrainAskSurface(surfaceHost, this.app, this.services.brain, {
      onStateChange: (state) => this.setFrameState(state),
      context: this.options.context,
      related: this.services.related,
    });

    // Close affordance (ESC also works; Obsidian wires that automatically).
    const closeBtn = frame.createDiv({ cls: "sovereign-overlay-close" });
    closeBtn.setText("✕");
    closeBtn.setAttribute("aria-label", "Close Sovereign Brain");
    closeBtn.setAttribute("role", "button");
    closeBtn.setAttribute("tabindex", "0");
    const close = (): void => this.close();
    closeBtn.addEventListener("click", close);
    closeBtn.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        close();
      }
    });

    // Open into a ready-to-type state.
    this.surface.focusInput();

    // Graph integration: a pre-filled question asks immediately.
    if (this.options.query) {
      this.surface.askQuestion(this.options.query);
    }
  }

  /** Beam phases mirror the ask lifecycle; errors stay restrained. */
  private setFrameState(state: "idle" | "thinking" | "answered" | "error"): void {
    if (!this.frame) return;
    this.frame.removeClass("is-thinking", "is-error", "is-answered");
    if (state === "thinking") this.frame.addClass("is-thinking");
    else if (state === "error") this.frame.addClass("is-error");
    else if (state === "answered") this.frame.addClass("is-answered");
  }

  onClose(): Promise<void> {
    if (this.cssRef) {
      this.app.workspace.offref(this.cssRef);
      this.cssRef = null;
    }
    this.surface = null;
    this.frame = null;
    this.contentEl.empty();
    return Promise.resolve();
  }
}

/**
 * Open the overlay. `query` opens mid-question (the caller owns the wording —
 * e.g. the graph's "Ask Sovereign" passes the note title verbatim); `context`
 * carries the real note/selection the user was looking at.
 */
export function openSovereignOverlay(
  app: App,
  services: SovereignOverlayServices,
  options: SovereignOverlayOptions = {},
): void {
  new SovereignOverlayModal(app, services, options).open();
}
