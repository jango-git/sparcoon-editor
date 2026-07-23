/**
 * Which graph is shown - Render or Behavior. UI state (not document state): the graph panel's own
 * switch sets it, and both the graph panel and its status display read it. A tiny observable so both
 * stay in sync.
 */

import { createSignal, type Signal } from "./primitives/signal";
import { t } from "../i18n";

export enum GraphMode {
  Render = "render",
  Behavior = "behavior",
}

export class GraphViewState {
  // The Behavior graph is the default on start: an emitter's motion/spawn is authored there
  // first, and the graph panel's switch + status display read this initial mode.
  private readonly signal: Signal<GraphMode> = createSignal(GraphMode.Behavior);

  public get mode(): GraphMode {
    return this.signal.get();
  }

  public setMode(mode: GraphMode): void {
    this.signal.set(mode);
  }

  public onChange(listener: (mode: GraphMode) => void): () => void {
    return this.signal.onChange(listener);
  }
}

export function graphModeLabel(mode: GraphMode): string {
  return mode === GraphMode.Render ? t("graph.modeRender") : t("graph.modeBehavior");
}
