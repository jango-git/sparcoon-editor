/**
 * A tiny observable value. The "hold a value, notify a Set of listeners on change, hand back an
 * unsubscribe" pattern was hand-rolled in graphViewState, inputMode and panelFocus (and, in the
 * model/settings layer, a few more that can't import from `ui`). Each UI store now wraps one of
 * these and keeps only its domain-named accessors.
 */

export interface Signal<T> {
  get(): T;
  /** Sets the value and notifies; a no-op when unchanged (`===`), so listeners see real changes only. */
  set(value: T): void;
  /** Subscribes to changes; returns an unsubscribe. */
  onChange(listener: (value: T) => void): () => void;
}

export function createSignal<T>(initial: T): Signal<T> {
  let value = initial;
  const listeners = new Set<(value: T) => void>();
  return {
    get: () => value,
    set: (next): void => {
      if (next === value) {
        return;
      }
      value = next;
      for (const listener of listeners) {
        listener(next);
      }
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
