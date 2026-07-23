/**
 * Global mouse-vs-touchpad UI state (the middlebar toggle sets it); the graph canvas and viewport both
 * read it to pick wheel-gesture semantics: mouse wheel zooms (Ctrl+wheel also zooms, drag orbits/
 * pans); touchpad two-finger scroll pans, pinch (Ctrl+wheel) zooms, drag still orbits/pans. Persisted
 * as an editor preference (see {@link PersistedStore}) so the choice survives a reload.
 */

import { isRecord } from "../util/guards";
import { PersistedStore } from "../settings/persistedStore";

export enum InputMode {
  Mouse = "mouse",
  Touchpad = "touchpad",
}

interface InputModeSettings {
  readonly mode: InputMode;
}

const DEFAULT_INPUT_MODE_SETTINGS: InputModeSettings = { mode: InputMode.Mouse };

const STORAGE_KEY = "sparcoon-editor.inputMode";

export class InputModeState {
  private readonly store = new PersistedStore<InputModeSettings>(
    STORAGE_KEY,
    DEFAULT_INPUT_MODE_SETTINGS,
    parseInputModeSettings,
  );

  public get mode(): InputMode {
    return this.store.get().mode;
  }

  public setMode(mode: InputMode): void {
    this.store.update({ mode });
  }

  public onChange(listener: (mode: InputMode) => void): () => void {
    return this.store.subscribe((settings) => listener(settings.mode));
  }
}

export function inputModeLabel(mode: InputMode): string {
  return mode === InputMode.Touchpad ? "Touchpad" : "Mouse";
}

function parseInputModeSettings(raw: unknown): InputModeSettings {
  if (!isRecord(raw)) {
    return DEFAULT_INPUT_MODE_SETTINGS;
  }
  return { mode: raw["mode"] === InputMode.Touchpad ? InputMode.Touchpad : InputMode.Mouse };
}
