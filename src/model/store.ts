/**
 * The single point of access to editor state. Commands mutate source only by producing a new
 * `SourceState` and calling `commit`, which distinguishes structural edits (recompute derived)
 * from view-only ones and announces each via the signal bus.
 */

import type { DerivedState, EditorState, SourceState } from "./editorState";
import { History } from "./history";
import type { ChangeKind } from "./history";
import type { SignalBus } from "./signals";

export type { ChangeKind };

export class Store {
  private readonly state: EditorState;
  private readonly history: History;

  constructor(
    initial: EditorState,
    private readonly signals: SignalBus,
  ) {
    this.state = initial;
    this.history = new History(initial.source);
  }

  public get canUndo(): boolean {
    return this.history.canUndo;
  }

  public get canRedo(): boolean {
    return this.history.canRedo;
  }

  /** Read access to the whole state. Callers must not mutate it directly. */
  public getState(): EditorState {
    return this.state;
  }

  public getSource(): SourceState {
    return this.state.source;
  }

  /** Applies a new source and records it, then announces the appropriate event. */
  public commit(next: SourceState, kind: ChangeKind): void {
    this.state.source = next;
    this.history.record(next, kind);
    this.emitForKind(kind);
    this.signals.emit("historyChanged", undefined);
  }

  /**
   * Applies a new source WITHOUT recording it in history - a live in-progress preview during a
   * drag gesture. `history.present` stays unchanged, so the gesture's eventual `commit()` on
   * release still records exactly one undo step for the whole gesture.
   */
  public commitLive(next: SourceState, kind: ChangeKind): void {
    this.state.source = next;
    this.emitForKind(kind);
  }

  /** Replaces derived data (called by the pipeline) and announces it. */
  public setDerived(patch: Partial<DerivedState>): void {
    Object.assign(this.state.derived, patch);
    this.signals.emit("derivedChanged", undefined);
  }

  /** Undoes the last commit, re-announcing the same kind that commit was made with. */
  public undo(): void {
    const restored = this.history.undo();
    if (restored !== undefined) {
      this.state.source = restored.state;
      this.emitForKind(restored.kind);
      this.signals.emit("historyChanged", undefined);
    }
  }

  /** Redoes the last undone commit, re-announcing the same kind that commit was made with. */
  public redo(): void {
    const restored = this.history.redo();
    if (restored !== undefined) {
      this.state.source = restored.state;
      this.emitForKind(restored.kind);
      this.signals.emit("historyChanged", undefined);
    }
  }

  private emitForKind(kind: ChangeKind): void {
    if (kind === "structural") {
      this.signals.emit("sourceStructureChanged", undefined);
    } else {
      this.signals.emit("sourceViewChanged", undefined);
    }
  }
}
