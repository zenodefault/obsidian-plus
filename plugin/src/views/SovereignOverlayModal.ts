/**
 * SovereignOverlayModal — the hotkey popup. A centered floating window that
 * hosts the full BrainPanel, framed by a motion-graphics border: a single
 * comet of light tracing the perimeter over a quiet instrument-panel shell.
 *
 * Restraint rules (the "not AI-generated" aesthetic):
 * - one animated element (the border trace), everything else static;
 * - accent color inherited from the active Obsidian theme;
 * - `prefers-reduced-motion` and the `borderMotion` setting both collapse
 *   the animation to a static hairline.
 */

import { Modal, App } from "obsidian";
import { BrainPanel, type BrainPanelServices, type SovereignTab } from "../components/BrainPanel";
import type SovereignSecondBrainPlugin from "../main";

export class SovereignOverlayModal extends Modal {
  private panel: BrainPanel | null = null;

  constructor(
    app: App,
    private plugin: SovereignSecondBrainPlugin,
    private services: BrainPanelServices,
    private initialTab?: SovereignTab,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl, modalEl } = this;
    contentEl.empty();
    modalEl.addClass("sovereign-overlay-modal");
    if (!this.plugin.settings.borderMotion) {
      modalEl.addClass("sovereign-motion-off");
    }

    // The frame carries the animated border; the panel sits inside it.
    const frame = contentEl.createDiv({ cls: "sovereign-overlay-frame" });
    frame.createDiv({ cls: "sovereign-border-trace" });
    frame.createDiv({ cls: "sovereign-border-glow" });

    const panelHost = frame.createDiv({ cls: "sovereign-overlay-body" });
    this.panel = new BrainPanel(panelHost, this.app, this.services, {
      initialTab: this.initialTab,
      onTabChanged: (tab) => {
        this.plugin.settings.lastOverlayTab = tab;
        void this.plugin.saveSettings();
      },
    });

    // Close affordance (ESC also works; Obsidian wires that automatically).
    const closeBtn = frame.createDiv({ cls: "sovereign-overlay-close" });
    closeBtn.setText("✕");
    closeBtn.setAttribute("aria-label", "Close Sovereign Brain");
    closeBtn.addEventListener("click", () => this.close());

    // Open into a ready-to-type state: focus the Ask input.
    this.panel.focusAskInput();
  }

  onClose(): Promise<void> {
    this.panel?.destroy();
    this.panel = null;
    this.contentEl.empty();
    return Promise.resolve();
  }
}

/** Open the overlay, restoring the last active tab unless overridden. */
export function openSovereignOverlay(
  app: App,
  plugin: SovereignSecondBrainPlugin,
  services: BrainPanelServices,
  tab?: SovereignTab,
): void {
  new SovereignOverlayModal(app, plugin, services, tab ?? plugin.settings.lastOverlayTab).open();
}
