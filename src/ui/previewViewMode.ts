/**
 * What the preview viewport shows: the shaded frame, or one of the overdraw views. UI state, set
 * from the viewport's Overdraw tab and read by the render loop. Not persisted: a reload shows the
 * shaded frame.
 */

import type { OverdrawCount } from "../render/overdrawShader";
import { createSignal, type Signal } from "./primitives/signal";

export type PreviewViewMode = "shaded" | OverdrawCount;

export class PreviewViewModeState {
  private readonly signal: Signal<PreviewViewMode> = createSignal<PreviewViewMode>("shaded");

  public get mode(): PreviewViewMode {
    return this.signal.get();
  }

  /** Whether an overdraw view is on, which shows its legend, stats row and tab mark. */
  public get overdrawOn(): boolean {
    return this.signal.get() !== "shaded";
  }

  public setMode(mode: PreviewViewMode): void {
    this.signal.set(mode);
  }

  public onChange(listener: (mode: PreviewViewMode) => void): () => void {
    return this.signal.onChange(listener);
  }
}
