/**
 * BrainAskSurface — the entire Sovereign Brain popup: a focused Ask surface.
 *
 * The popup does one thing: the user asks their second brain a question and
 * gets a grounded answer with real sources. There are no tabs, no status bar,
 * no dashboard — question → thinking → answer → sources → ask again. The quiet
 * "✦ Ask your second brain" hero disappears once a question is in flight so the
 * answer owns the surface; the context chip (when the popup was opened from a
 * note) stays visible so the user knows what Sovereign is looking at.
 */

import { App } from "obsidian";
import type { BrainDataService } from "../services/brainDataService";
import {
  AskViewComponent,
  type AskContext,
  type AskLifecycleState,
  type RelatedProvider,
} from "./AskViewComponent";

export interface BrainAskSurfaceOptions {
  /** Lifecycle of the current query (drives the BorderBeam states). */
  onStateChange?: (state: AskLifecycleState) => void;
  /** Real editor context this popup was opened from. */
  context?: AskContext;
  /** Real related-note lookup (vault links), when available. */
  related?: RelatedProvider;
}

export class BrainAskSurface {
  private ask: AskViewComponent;
  private heroEl!: HTMLElement;

  constructor(
    parentEl: HTMLElement,
    app: App,
    brain: BrainDataService,
    private options: BrainAskSurfaceOptions = {},
  ) {
    const root = parentEl.createDiv({ cls: "sovereign-brain-surface" });

    // The one permanent element: a whisper of product identity.
    this.heroEl = root.createDiv({ cls: "sovereign-brain-hero" });
    this.heroEl.createSpan({
      text: "✦",
      cls: "sovereign-brain-hero-mark",
      attr: { "aria-hidden": "true" },
    });
    this.heroEl.createSpan({ text: "Ask your second brain", cls: "sovereign-brain-hero-text" });

    this.ask = new AskViewComponent(root, app, brain, {
      onStateChange: (state) => this.onAskState(state),
      context: options.context,
      related: options.related,
    });
  }

  private onAskState(state: AskLifecycleState): void {
    // The hero yields once the user is actually consulting the brain; the
    // in-flow Thinking… state carries the progress message itself.
    this.heroEl.toggleClass("is-hidden", state !== "idle");
    this.options.onStateChange?.(state);
  }

  /** Open into a ready-to-type state. */
  focusInput(): void {
    this.ask.focusInput();
  }

  /** Pre-fill and immediately ask (graph → "Ask Sovereign" integration). */
  askQuestion(query: string): void {
    this.ask.setQuery(query);
    this.focusInput();
  }
}
