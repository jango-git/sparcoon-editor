/**
 * Focus-follows-mouse: each panel registers its root element; one document-level `pointerover`
 * listener resolves the topmost hovered element (`event.target`) to its containing registered root
 * by DOM containment, so an overlay drawn over another panel resolves correctly with no z-index
 * bookkeeping. Sticky: hovering chrome that belongs to no registered panel leaves the active panel
 * unchanged rather than clearing it - see {@link PanelFocus}.
 */

import type { EditorPanel, PanelFocus } from "./panelFocus";

interface Registration {
  readonly element: HTMLElement;
  readonly panel: EditorPanel;
}

export class PanelFocusTracker {
  private readonly registrations: Registration[] = [];

  constructor(private readonly focus: PanelFocus) {
    // `pointerover` fires as the cursor crosses element boundaries and bubbles, so a single
    // document listener sees every panel entry without per-element wiring.
    document.addEventListener("pointerover", (event) => this.onPointerOver(event));
  }

  /** Registers a panel's root; hovering anywhere inside it makes that panel active. */
  public register(element: HTMLElement, panel: EditorPanel): void {
    this.registrations.push({ element, panel });
  }

  private onPointerOver(event: PointerEvent): void {
    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }
    // Nearest registered root that contains the hovered element wins. Registrations are checked
    // in order; panels never nest, so at most one contains the target.
    for (const { element, panel } of this.registrations) {
      if (element.contains(target)) {
        this.focus.setActive(panel);
        return;
      }
    }
    // Over chrome that belongs to no panel - keep the last active panel (sticky).
  }
}
