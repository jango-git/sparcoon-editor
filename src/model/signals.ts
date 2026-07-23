/**
 * Typed event bus for the model layer: it announces *what* changed with distinct event types
 * (never one generic "changed"), and subscribers react only to the events they care about.
 */

/** The set of events the model can emit, mapped to their payload type. */
export interface EditorEventMap {
  /** Source changed structurally; the derived pipeline must recompute. */
  sourceStructureChanged: void;
  /** Source changed in a view-only way (e.g. node moved); no recompute needed. */
  sourceViewChanged: void;
  /** Derived render/behavior snapshots were recomputed and applied. */
  derivedChanged: void;
  /** Undo/redo availability changed. */
  historyChanged: void;
}

type EditorEventName = keyof EditorEventMap;

type EditorEventListener<TName extends EditorEventName> = (payload: EditorEventMap[TName]) => void;

/** A minimal, fully typed publish/subscribe bus. */
export class SignalBus {
  private readonly listeners = new Map<EditorEventName, Set<(payload: never) => void>>();

  public on<TName extends EditorEventName>(
    name: TName,
    listener: EditorEventListener<TName>,
  ): () => void {
    let set = this.listeners.get(name);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  public emit<TName extends EditorEventName>(name: TName, payload: EditorEventMap[TName]): void {
    const set = this.listeners.get(name);
    if (set === undefined) {
      return;
    }
    for (const listener of set) {
      (listener as EditorEventListener<TName>)(payload);
    }
  }
}
