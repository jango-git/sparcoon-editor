/**
 * Undo/redo over the *source* only. A snapshot is a whole `SourceState`, cheap since source is
 * immutable (structural sharing, no deep clone); each entry keeps its {@link ChangeKind} so undo/redo re-announces the original kind (see {@link Store.undo}).
 */

import type { SourceState } from "./editorState";

/** Whether a committed edit changes the compiled program or only the view. */
export type ChangeKind = "structural" | "view";

/** A past/future entry: the source at that point, and the kind of the transition away from it. */
interface HistoryEntry {
  readonly state: SourceState;
  readonly kind: ChangeKind;
}

/** A source restored by undo/redo, tagged with the kind of the transition being reversed/replayed. */
export interface HistoryRestore {
  readonly state: SourceState;
  readonly kind: ChangeKind;
}

export class History {
  private readonly past: HistoryEntry[] = [];
  private readonly future: HistoryEntry[] = [];
  private present: SourceState;

  constructor(initial: SourceState) {
    this.present = initial;
  }

  public get canUndo(): boolean {
    return this.past.length > 0;
  }

  public get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Records a new source as the present, pushing the old one onto the undo stack. */
  public record(next: SourceState, kind: ChangeKind): void {
    this.past.push({ state: this.present, kind });
    this.present = next;
    this.future.length = 0;
  }

  /** Restores the previous source, or `undefined` if there is nothing to undo. */
  public undo(): HistoryRestore | undefined {
    const entry = this.past.pop();
    if (entry === undefined) {
      return undefined;
    }
    this.future.push({ state: this.present, kind: entry.kind });
    this.present = entry.state;
    return { state: this.present, kind: entry.kind };
  }

  /** Re-applies the most recently undone source, or `undefined` if none. */
  public redo(): HistoryRestore | undefined {
    const entry = this.future.pop();
    if (entry === undefined) {
      return undefined;
    }
    this.past.push({ state: this.present, kind: entry.kind });
    this.present = entry.state;
    return { state: this.present, kind: entry.kind };
  }
}
