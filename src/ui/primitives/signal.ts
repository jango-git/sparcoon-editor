/**
 * A tiny observable value: holds it and announces each change. The UI stores (graphViewState,
 * inputMode, panelFocus) each wrap one and keep only their domain-named accessors.
 */

import { Ferrsign1 } from "ferrsign";

export interface Signal<T> {
  get(): T;
  /** Sets the value and notifies; a no-op when unchanged (`===`), so listeners see real changes only. */
  set(value: T): void;
  /** Subscribes to changes; returns an unsubscribe. */
  onChange(listener: (value: T) => void): () => void;
}

export function createSignal<T>(initial: T): Signal<T> {
  let value = initial;
  const changed = new Ferrsign1<T>();
  return {
    get: () => value,
    set: (next): void => {
      if (next === value) {
        return;
      }
      value = next;
      changed.emit(next);
    },
    onChange: (listener) => changed.on(listener),
  };
}
