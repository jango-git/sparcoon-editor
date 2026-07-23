/**
 * Theme is persisted as a raw string (not JSON) and applied via `data-theme` on <html>. The
 * pre-paint script in index.html reads the same `STORAGE_KEY` synchronously before first paint to
 * avoid a flash of the wrong theme - keep the key and its `dark`/`light`/`auto` values in sync
 * with that script.
 */

import { readString, writeString } from "../util/storage";

export type ThemeMode = "dark" | "light" | "auto";

const STORAGE_KEY = "sparcoon-editor.theme";
const listeners = new Set<() => void>();
let systemDark: MediaQueryList | undefined;

/** Lazily acquired so importing this module has no DOM side effect at load time. */
function systemDarkQuery(): MediaQueryList {
  return (systemDark ??= window.matchMedia("(prefers-color-scheme: dark)"));
}

export function getThemeMode(): ThemeMode {
  const stored = readString(STORAGE_KEY);
  if (stored === "dark" || stored === "light" || stored === "auto") {
    return stored;
  }
  return "auto";
}

export function setThemeMode(mode: ThemeMode): void {
  writeString(STORAGE_KEY, mode);
  applyThemeMode(mode);
  emit();
}

/** Subscribe to theme-mode changes (a user toggle or, in auto mode, an OS flip). */
export function onThemeChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Re-applies the persisted theme and installs the live OS-preference listener; only `auto`
 *  re-resolves when the OS flips light/dark. */
export function initTheme(): void {
  applyThemeMode(getThemeMode());
  systemDarkQuery().addEventListener("change", () => {
    if (getThemeMode() !== "auto") {
      return;
    }
    applyThemeMode("auto");
    emit();
  });
}

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function applyThemeMode(mode: ThemeMode): void {
  const resolved = mode === "auto" ? resolveSystemTheme() : mode;
  document.documentElement.setAttribute("data-theme", resolved);
}

function resolveSystemTheme(): "dark" | "light" {
  return systemDarkQuery().matches ? "dark" : "light";
}
