/**
 * One UI setting persisted to its own localStorage key: holds the live value, mirrors changes back
 * to storage best-effort (a blocked store must never break the editor), and notifies subscribers.
 * `parse` defends the loaded value against corrupt/absent storage. Editor preferences only - never
 * touches the document, undo history, or the saved source.
 */

import { readJson, writeJson } from "../util/storage";

export type SettingsListener<T> = (value: T) => void;

export class PersistedStore<T extends object> {
  private value: T;
  private readonly listeners = new Set<SettingsListener<T>>();

  constructor(
    private readonly key: string,
    fallback: T,
    parse: (raw: unknown) => T,
  ) {
    const raw = readJson(key);
    this.value = raw === undefined ? fallback : parse(raw);
  }

  public get(): T {
    return this.value;
  }

  public update(patch: Partial<T>): void {
    this.value = { ...this.value, ...patch };
    writeJson(this.key, this.value);
    for (const listener of this.listeners) {
      listener(this.value);
    }
  }

  /** Subscribe to changes; returns an unsubscribe. The listener fires on every {@link update}. */
  public subscribe(listener: SettingsListener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
