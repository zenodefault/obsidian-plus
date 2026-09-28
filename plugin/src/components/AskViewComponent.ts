/**
 * AskViewComponent — the question→thinking→answer flow, shared by the
 * Sovereign Brain popup and any future host.
 *
 * Presentation rules (Workstream: overlay redesign):
 * - The question is echoed as the primary object; the answer, sources and
 *   only genuinely present context follow beneath it. No chat transcript,
 *   no avatars, no message history.
 * - The thinking state is a quiet text pulse ("Thinking…"), never a spinner
 *   and never fabricated reasoning.
 * - Sources stay real and clickable (they open the actual note); each item
 *   is collapsed to a title row until expanded, so provenance is preserved
 *   without burying the answer.
 * - Errors are concise ("Unable to answer right now. Your notes were not
 *   modified."); details go to the console, not the UI.
 *
 * The host observes lifecycle via `onStateChange` so it can drive its own
 * visual states (e.g. the BorderBeam's thinking phase).
 */

import { App } from "obsidian";
import { AskQueryResult, AskSource } from "../types/protocol";
import type { BrainDataService } from "../services/brainDataService";

/** Host-visible lifecycle of a query. */
export type AskLifecycleState = "idle" | "thinking" | "answered" | "error";

/** Real editor context the popup was opened from (never inferred). */
export interface AskContext {
  /** Basename of the note the user was in. */
  label: string;
  /** Vault path of that note, when known. */
  path?: string;
  /** Exactly what the user had selected, when anything was selected. */
  selectedText?: string;
}

/** A real note related to an answer (from the vault's own link graph). */
export interface RelatedNote {
  path: string;
  title: string;
}

/**
 * Host-supplied related-note lookup: given the source paths of an answer,
 * return other notes actually linked to them. Only real vault links — the
 * popup never invents associations.
 */
export type RelatedProvider = (sourcePaths: string[]) => RelatedNote[];

export interface AskViewOptions {
  /** Lifecycle hook (e.g. beam states in the popup). Never blocks. */
  onStateChange?: (state: AskLifecycleState) => void;
  /**
   * When the flow ends in an error, hosts may surface a restrained visual
   * state. Called once per failed query with a short user-facing message.
   */
  onError?: (message: string) => void;
  /** Where the user was when the popup opened. */
  context?: AskContext;
  /** Real related-note lookup (vault links), when the host can provide one. */
  related?: RelatedProvider;
}

/** Short user-facing error text; details are logged, not shown. */
const ASK_ERROR_MESSAGE = "Unable to answer right now. Your notes were not modified.";

/** The question surface owns its own copy: this is the product's voice. */
const PLACEHOLDER_IDLE = "What would you like to know?";
const PLACEHOLDER_AGAIN = "Ask another question…";

/** The deterministic evidence summary's fixed opener (core §58 fallback). */
const EVIDENCE_ANSWER_PREFIX = "Here is what your vault contains about this:";

/**
 * Render one answer paragraph. Plain text in, safe DOM out — but the core's
 * citation markers ([Folder/Note.md], [[Note]]) become quiet footnote-style
 * links instead of raw bracket noise: hover/inspect on demand, never noise.
 */
function renderAnswerParagraph(parent: HTMLElement, text: string): void {
  const pattern = /\[([^\]\n]+)\]/g;
  let last = 0;
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    const inner = (m[1] ?? "").trim();
    const looksLikeCitation =
      /\.md$/i.test(inner) ||
      /^\[\[/.test(m[0]) ||
      inner.includes("/");
    if (!looksLikeCitation) continue;
    if (m.index > last) {
      parent.createSpan({ text: text.slice(last, m.index) });
    }
    const label = (inner.split("/").pop() ?? inner).replace(/\.md$/i, "");
    parent.createSpan({ text: label, cls: "sovereign-cite-ref" });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    parent.createSpan({ text: text.slice(last) });
  }
}

export class AskViewComponent {
  private containerEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private resultContainerEl!: HTMLElement;
  private submitBtn!: HTMLButtonElement;
  private queryInFlight = false;
  private lastQuery: string | null = null;
  private hasAnswered = false;

  constructor(
    parentEl: HTMLElement,
    private app: App,
    private brain: BrainDataService,
    private options: AskViewOptions = {},
  ) {
    this.containerEl = parentEl.createDiv({ cls: "sovereign-ask-view" });
    this.buildInputArea();
    this.resultContainerEl = this.containerEl.createDiv({
      cls: "sovereign-ask-results",
      attr: { "aria-live": "polite", "aria-busy": "false" },
    });
  }

  private buildInputArea(): void {
    // Context of where the user was: real note title (+ selection), shown as
    // a quiet chip rather than a control panel.
    if (this.options.context) {
      const ctx = this.options.context;
      const row = this.containerEl.createDiv({ cls: "sovereign-ask-context" });
      row.createSpan({ text: "Current note", cls: "sovereign-ask-context-key" });
      row.createSpan({ text: ctx.label, cls: "sovereign-ask-context-value" });
      if (ctx.selectedText) {
        const selected = row.createDiv({ cls: "sovereign-ask-context-sel" });
        selected.createSpan({ text: "Selected", cls: "sovereign-ask-context-key" });
        selected.createSpan({
          text: `“${this.snippet(ctx.selectedText)}”`,
          cls: "sovereign-ask-context-value",
        });
      }
    }

    const inputWrapper = this.containerEl.createDiv({ cls: "sovereign-ask-input-box" });

    this.inputEl = inputWrapper.createEl("textarea", {
      cls: "sovereign-textarea sovereign-ask-textarea",
      attr: {
        placeholder: PLACEHOLDER_IDLE,
        rows: "1",
        "aria-label": "Ask your second brain",
        spellcheck: "false",
      },
    });

    // Enter submits; Shift+Enter (and plain multiline editing) inserts a
    // newline. The textarea grows with its content, capped by CSS.
    this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submitFromInput();
      }
    });
    this.inputEl.addEventListener("input", () => this.autoGrow());

    const actionsRow = inputWrapper.createDiv({ cls: "sovereign-ask-actions" });
    actionsRow.createSpan({
      text: "Enter to ask · Shift+Enter for a new line",
      cls: "sovereign-ask-hint",
    });

    this.submitBtn = actionsRow.createEl("button", {
      text: "Ask",
      cls: "sovereign-btn-primary sovereign-ask-submit",
      attr: { "aria-label": "Ask" },
    });
    this.submitBtn.addEventListener("click", () => this.submitFromInput());
  }

  private autoGrow(): void {
    const el = this.inputEl;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }

  private submitFromInput(): void {
    if (this.queryInFlight) return;
    const q = this.inputEl.value.trim();
    if (q) {
      void this.ask(q);
      return;
    }
    // Empty input with real context: ask with the user's own context text
    // (the note title, or exactly what they had selected). The popup never
    // synthesizes a question on the user's behalf.
    const contextual = this.contextQuery();
    if (contextual) void this.ask(contextual);
  }

  /** The text an empty-input question would use, when context exists. */
  private contextQuery(): string | null {
    const ctx = this.options.context;
    if (!ctx) return null;
    const selected = ctx.selectedText?.trim();
    if (selected && selected.length > 0) return selected;
    const label = ctx.label.trim();
    return label.length > 0 ? label : null;
  }

  /** Truncate long excerpts/selections for chip display. */
  private snippet(text: string, max = 60): string {
    const collapsed = text.replace(/\s+/g, " ").trim();
    return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
  }

  /** Place keyboard focus in the ask input without disturbing its content. */
  focusInput(): void {
    this.inputEl.focus();
    // Put the caret at the end so a pre-filled question reads naturally.
    const end = this.inputEl.value.length;
    this.inputEl.setSelectionRange(end, end);
  }

  /** Programmatic ask: fills the input and immediately queries. */
  setQuery(query: string): void {
    this.inputEl.value = query;
    this.autoGrow();
    if (!this.queryInFlight) void this.ask(query);
  }

  /** The last query asked, for hosts that echo it (e.g. a status line). */
  get currentQuery(): string | null {
    return this.lastQuery;
  }

  private setState(state: AskLifecycleState): void {
    this.options.onStateChange?.(state);
  }

  private async ask(query: string): Promise<void> {
    this.queryInFlight = true;
    this.lastQuery = query;
    this.submitBtn.disabled = true;
    this.resultContainerEl.setAttribute("aria-busy", "true");
    // After the first answer the surface becomes "ask another…" — the same
    // input, quietly signaling the consultable state.
    if (this.hasAnswered) {
      this.inputEl.placeholder = PLACEHOLDER_AGAIN;
    }
    this.setState("thinking");

    // Reset the surface: the question echo becomes the header of the next
    // block, so each query reads as one clean flow (question → answer).
    this.resultContainerEl.empty();
    const flow = this.resultContainerEl.createDiv({ cls: "sovereign-ask-flow" });
    flow.createDiv({
      cls: "sovereign-ask-question",
      text: query,
    });

    const thinking = flow.createDiv({ cls: "sovereign-ask-thinking" });
    thinking.createSpan({ text: "Thinking", cls: "sovereign-ask-thinking-text" });
    thinking.createSpan({ cls: "sovereign-ask-thinking-dots", attr: { "aria-hidden": "true" } });

    try {
      const result = await this.brain.queryBrain(query);
      if (!this.resultContainerEl.isConnected) return;
      this.renderResult(flow, result);
      this.hasAnswered = true;
      this.setState("answered");
    } catch (err) {
      console.error("[sovereign] ask failed:", err);
      if (!this.resultContainerEl.isConnected) return;
      this.renderError(flow);
      this.setState("error");
      this.options.onError?.(ASK_ERROR_MESSAGE);
    } finally {
      this.queryInFlight = false;
      this.submitBtn.disabled = false;
      this.resultContainerEl.setAttribute("aria-busy", "false");
    }
  }

  private renderError(flow: HTMLElement): void {
    flow.querySelector(".sovereign-ask-thinking")?.remove();
    const box = flow.createDiv({ cls: "sovereign-ask-error" });
    box.createSpan({ text: "Unable to answer right now." });
    box.createSpan({ text: "Your notes were not modified.", cls: "sovereign-ask-error-sub" });
  }

  private renderResult(flow: HTMLElement, result: AskQueryResult): void {
    flow.querySelector(".sovereign-ask-thinking")?.remove();

    const answerCard = flow.createDiv({ cls: "sovereign-answer-card" });

    // The topic header the answer is about (the question, verbatim).
    answerCard.createDiv({
      cls: "sovereign-answer-topic",
      text: this.topicOf(result.query ?? this.currentQuery ?? ""),
    });

    // Confidence: a small inline indicator, not a banner.
    const answerBody = answerCard.createDiv({ cls: "sovereign-answer-body" });
    this.renderAnswer(answerBody, result);

    if (result.sources.length > 0 || result.confidence !== "low") {
      answerCard.createDiv({
        cls: `sovereign-conf-line sovereign-conf-${result.confidence}`,
        text:
          result.confidence === "high"
            ? "Strong grounding in your notes"
            : result.confidence === "medium"
              ? "Grounded in your notes"
              : "Weak grounding — verify in sources",
      });
    }

    // Potential contradictions: only when they exist.
    if (result.conflicts && result.conflicts.length > 0) {
      for (const conflict of result.conflicts) {
        const conflictBox = answerCard.createDiv({
          cls: "sovereign-alert-box sovereign-alert-warning",
        });
        conflictBox.createDiv({
          cls: "sovereign-alert-title",
          text: "⚠️ Potential contradiction",
        });
        const cGrid = conflictBox.createDiv({ cls: "sovereign-alert-grid" });
        const col1 = cGrid.createDiv({ cls: "sovereign-alert-col" });
        col1.createSpan({ text: "Earlier:", cls: "sovereign-text-muted sovereign-text-xs" });
        col1.createEl("blockquote", { text: `"${conflict.earlier}"` });
        col1.createSpan({
          text: this.sourceTitle(conflict.earlier_source),
          cls: "sovereign-source-path",
        });
        const col2 = cGrid.createDiv({ cls: "sovereign-alert-col" });
        col2.createSpan({ text: "Later:", cls: "sovereign-text-muted sovereign-text-xs" });
        col2.createEl("blockquote", { text: `"${conflict.later}"` });
        col2.createSpan({
          text: this.sourceTitle(conflict.later_source),
          cls: "sovereign-source-path",
        });
        conflictBox.createDiv({
          cls: "sovereign-alert-interp sovereign-text-sm",
          text: `Note: ${conflict.interpretation}`,
        });
      }
    }

    // Sources: real notes, collapsed until expanded. Provenance preserved.
    if (result.sources.length > 0) {
      const srcSection = answerCard.createDiv({ cls: "sovereign-sources-section" });
      srcSection.createDiv({
        cls: "sovereign-section-subhead",
        text: `Sources · ${result.sources.length}`,
      });
      const srcList = srcSection.createDiv({ cls: "sovereign-sources-list" });
      result.sources.forEach((src, i) => {
        srcList.appendChild(this.buildSourceItem(src, i === 0));
      });
    }

    // Related memories: only when the core actually returned some.
    if (result.memories.length > 0) {
      const memSection = answerCard.createDiv({ cls: "sovereign-memories-drawer" });
      memSection.createDiv({
        cls: "sovereign-section-subhead",
        text: `Related memory · ${result.memories.length}`,
      });
      for (const mem of result.memories) {
        const memItem = memSection.createDiv({ cls: "sovereign-memory-chip" });
        memItem.createSpan({
          text: mem.statement,
          cls: "sovereign-memory-statement",
        });
        memItem.createSpan({
          text: mem.type,
          cls: `sovereign-badge sovereign-badge-${mem.type}`,
        });
      }
    }

    // RELATED — other notes actually linked to this answer's sources, from
    // the vault's own link graph. Shown only when the host supplies them and
    // only when something genuinely exists.
    this.renderRelated(answerCard, result);
  }

  /**
   * The answer body: one paragraph per line of the core's answer. The
   * deterministic evidence fallback (a bullet list of raw snippets) is
   * presented as the compact "notes that mention this" list it actually is —
   * not as a fake prose answer.
   */
  private renderAnswer(answerBody: HTMLElement, result: AskQueryResult): void {
    const raw = (result.answer ?? "").trim();
    if (!raw) return;
    const lines = raw
      .split(/\n+/)
      .map((l) => l.replace(/^[-*]\s+/, "").trim())
      .filter((l) => l.length > 0);

    const isEvidenceDump =
      lines.length > 1 && raw.includes(EVIDENCE_ANSWER_PREFIX);
    if (isEvidenceDump) {
      answerBody.createEl("p", {
        text: "Your notes mention this in several places:",
        cls: "sovereign-answer-lede",
      });
      for (const line of lines.filter((l) => !l.startsWith(EVIDENCE_ANSWER_PREFIX))) {
        const p = answerBody.createEl("p", { cls: "sovereign-answer-evidence" });
        renderAnswerParagraph(p, line);
      }
      return;
    }

    for (const line of lines) {
      const p = answerBody.createEl("p");
      renderAnswerParagraph(p, line);
    }
  }

  /** "What do I know about motor anomaly detection?" → "Motor anomaly detection". */
  private topicOf(query: string): string {
    let q = query.trim().replace(/[?!.]+$/, "");
    const m =
      q.match(/^(?:what (?:do|is|are)|who) (?:i|we|my|the)?\s*(?:know|need to know)?\s*(?:about|regarding|on)\s+(.+)$/i) ??
      q.match(/^(?:tell me )?about\s+(.+)$/i) ??
      q.match(/^(?:how|why|when|where)\s+(?:do|does|did|to)\s+(?:i|we|my)?\s*(.+)$/i);
    q = (m?.[1] ?? q).trim();
    return q.charAt(0).toUpperCase() + q.slice(1);
  }

  private renderRelated(answerCard: HTMLElement, result: AskQueryResult): void {
    const provider = this.options.related;
    if (!provider || result.sources.length === 0) return;
    const cited = new Set(result.sources.map((s) => s.path));
    const related = provider(result.sources.map((s) => s.path)).filter(
      (note) => !cited.has(note.path),
    );
    if (related.length === 0) return;

    const section = answerCard.createDiv({ cls: "sovereign-related-section" });
    section.createDiv({ cls: "sovereign-section-subhead", text: "RELATED" });
    const list = section.createDiv({ cls: "sovereign-related-list" });
    for (const note of related) {
      const link = list.createEl("a", {
        text: note.title,
        cls: "sovereign-related-link",
        attr: { href: "#" },
      });
      link.addEventListener("click", (e) => {
        e.preventDefault();
        void this.app.workspace.openLinkText(note.path, "", false);
      });
    }
  }

  /** "folder/Note Name.md" → "Note Name" for display. */
  private sourceTitle(path: string): string {
    const base = path.split("/").pop() ?? path;
    return base.replace(/\.md$/i, "");
  }

  /**
   * One collapsible source row. The title always opens the real note; the
   * caret toggles the excerpt.
   */
  private buildSourceItem(src: AskSource, expanded: boolean): HTMLElement {
    const item = createDiv({ cls: "sovereign-source-item" });
    if (expanded) item.addClass("is-open");

    const head = item.createDiv({ cls: "sovereign-source-head" });
    const link = head.createEl("a", {
      text: this.sourceTitle(src.path),
      cls: "sovereign-source-link",
    });
    // Real provenance: opens the actual note in Obsidian.
    link.addEventListener("click", (e) => {
      e.preventDefault();
      void this.app.workspace.openLinkText(src.path, "", false);
    });

    if (src.score !== undefined) {
      head.createSpan({
        text: `${Math.round(src.score * 100)}%`,
        cls: "sovereign-source-score",
      });
    }

    // Decorative caret; the whole head row is the toggle affordance.
    head.createSpan({
      cls: "sovereign-source-caret",
      attr: { "aria-hidden": "true" },
    });
    const excerpt = item.createDiv({ cls: "sovereign-source-excerpt" });
    // Single animated child (the grid-row reveal animates one element).
    const excerptInner = excerpt.createDiv({ cls: "sovereign-source-excerpt-inner" });
    excerptInner.createEl("p", { text: src.excerpt });
    // Explicit affordance for provenance: the excerpt reads, the link opens.
    const openLink = excerptInner.createEl("a", {
      text: "Open note →",
      cls: "sovereign-source-open",
      attr: { href: "#" },
    });
    openLink.addEventListener("click", (e) => {
      e.preventDefault();
      void this.app.workspace.openLinkText(src.path, "", false);
    });

    // The CSS animates the excerpt from the is-open class; JS only flips it.
    // Keyboard users toggle through the head row (it is focusable below).
    const toggle = (): void => {
      const open = !item.hasClass("is-open");
      item.toggleClass("is-open", open);
      item.setAttribute("aria-expanded", open ? "true" : "false");
    };
    item.setAttribute("aria-expanded", expanded ? "true" : "false");
    head.addEventListener("click", (e) => {
      // The title link opens the note; clicks elsewhere toggle the excerpt.
      if (e.target !== link) toggle();
    });
    head.setAttribute("role", "button");
    head.setAttribute("tabindex", "0");
    head.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });

    return item;
  }
}
