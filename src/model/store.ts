/**
 * Access to editor state. Commands produce a new `SourceState` and call `commit`, which announces a
 * structural or view change through {@link events}.
 */

import type { DerivedState, EditorState, SourceState } from "./editorState";
import type { ChangeKind } from "./history";
import { History } from "./history";
import { type EditorEvents, EditorSignals } from "./signals";

export type { ChangeKind };

export class Store {
  private readonly state: EditorState;
  private readonly history: History;
  private readonly signals = new EditorSignals();

  constructor(initial: EditorState) {
    this.state = initial;
    this.history = new History(initial.source);
  }

  /** What changed, announced after each change. */
  public get events(): EditorEvents {
    return this.signals;
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

  public commit(next: SourceState, kind: ChangeKind): void {
    this.state.source = next;
    this.history.record(next, kind);
    this.emitForKind(kind);
    this.signals.historyChanged.emit();
  }

  /**
   * Applies a source without recording it in history, as a preview during a drag. The commit on
   * release records one undo step.
   */
  public commitLive(next: SourceState, kind: ChangeKind): void {
    this.state.source = next;
    this.emitForKind(kind);
  }

  public setDerived(patch: Partial<DerivedState>): void {
    Object.assign(this.state.derived, patch);
    this.signals.derivedChanged.emit();
  }

  /** Undoes the last commit, re-announcing the same kind that commit was made with. */
  public undo(): void {
    const restored = this.history.undo();
    if (restored !== undefined) {
      this.state.source = restored.state;
      this.emitForKind(restored.kind);
      this.signals.historyChanged.emit();
    }
  }

  /** Redoes the last undone commit, re-announcing the same kind that commit was made with. */
  public redo(): void {
    const restored = this.history.redo();
    if (restored !== undefined) {
      this.state.source = restored.state;
      this.emitForKind(restored.kind);
      this.signals.historyChanged.emit();
    }
  }

  private emitForKind(kind: ChangeKind): void {
    if (kind === "structural") {
      this.signals.sourceStructureChanged.emit();
    } else {
      this.signals.sourceViewChanged.emit();
    }
  }
}
