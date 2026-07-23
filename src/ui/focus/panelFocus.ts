/**
 * Which workspace panel is active (Viewport/Graph/Timeline/Assets) - UI state set by
 * {@link PanelFocusTracker} from the cursor, read by the hotkey router (to pick a keymap) and the
 * shell (to paint the accent ring). Sticky: moving onto chrome (middlebar, dividers, gaps) leaves the
 * last panel active, so a keystroke aimed at a panel still lands after a detour to a toolbar button.
 */

import { createSignal, type Signal } from "../primitives/signal";

export enum EditorPanel {
  Viewport = "viewport",
  Graph = "graph",
  Timeline = "timeline",
  Assets = "assets",
}

export class PanelFocus {
  // The graph is the dominant panel and the one hotkeys most often target, so it is the
  // default until the pointer first settles somewhere.
  private readonly signal: Signal<EditorPanel> = createSignal(EditorPanel.Graph);

  public get(): EditorPanel {
    return this.signal.get();
  }

  public isActive(panel: EditorPanel): boolean {
    return this.signal.get() === panel;
  }

  public setActive(panel: EditorPanel): void {
    this.signal.set(panel);
  }

  public onChange(listener: (panel: EditorPanel) => void): () => void {
    return this.signal.onChange(listener);
  }
}
