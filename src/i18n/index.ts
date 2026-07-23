/**
 * Locale dictionaries are fetched at runtime (see {@link initI18n}), not bundled, so the browser
 * downloads only the active locale plus the English fallback. `Dictionary` is derived from en.json via
 * `typeof import(...)`, a type-only import that emits no runtime code - en.json stays out of the bundle.
 */

import { readString, writeString } from "../util/storage";
import { initNodeText } from "./nodeText";
import { initCompilerErrors } from "./compilerErrors";
import { interpolate, type Params } from "./interpolate";

// `typeof import(...)` is the only way to get en.json's shape as a type without a value
// import (see header comment).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type Dictionary = typeof import("./locales/en.json");

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

type Leaves<T> = T extends string
  ? never
  : {
      [K in keyof T & string]: T[K] extends string ? K : `${K}.${Leaves<T[K]>}`;
    }[keyof T & string];

export type TKey = Leaves<Dictionary>;

type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>>;

export const LOCALE_NAMES: Record<string, string> = {
  en: "English",
  ru: "Русский",
  uk: "Українська",
};

export function localeBadge(code: string): string {
  return code.split("-")[0]?.toUpperCase() ?? code.toUpperCase();
}

const DEFAULT_LOCALE = "en";
const STORAGE_KEY = "sparcoon-editor.locale";

export function availableLocales(): string[] {
  return Object.keys(LOCALE_NAMES);
}

function detectLocale(): string {
  const stored = readString(STORAGE_KEY);
  if (stored !== undefined && LOCALE_NAMES[stored] !== undefined) {
    return stored;
  }
  const preferences = navigator.languages.length ? navigator.languages : [navigator.language];
  for (const preference of preferences) {
    if (!preference) {
      continue;
    }
    if (LOCALE_NAMES[preference] !== undefined) {
      return preference;
    }
    const base = preference.toLowerCase().split("-")[0];
    const hit = availableLocales().find((code) => code.toLowerCase().split("-")[0] === base);
    if (hit !== undefined) {
      return hit;
    }
  }
  return DEFAULT_LOCALE;
}

// Detection is deferred to initI18n (awaited before any t() call), so the module-load
// value only needs to be a valid locale for a stray pre-init getLocale().
let active = DEFAULT_LOCALE;
let activeDictionary: DeepPartial<Dictionary> = {};
let fallbackDictionary: DeepPartial<Dictionary> = {};

async function loadDictionary(code: string): Promise<DeepPartial<Dictionary>> {
  // Resolve next to the bundle (dist/locales/...), mirroring the copy-locales build step.
  const url = new URL(`locales/${code}.json`, import.meta.url);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load locale "${code}": ${response.status}`);
  }
  return (await response.json()) as DeepPartial<Dictionary>;
}

/** Must be awaited before any t() call (or any node-text/compiler-error resolver, see ./nodeText
 *  and ./compilerErrors). Loads the English fallback and (if different) the detected active
 *  locale, plus the node-text and compiler-error dictionaries for the same locale; a failed
 *  active load falls back to en. */
export async function initI18n(): Promise<void> {
  active = detectLocale();
  const [fallback, current] = await Promise.all([
    loadDictionary(DEFAULT_LOCALE),
    active === DEFAULT_LOCALE
      ? Promise.resolve(undefined)
      : loadDictionary(active).catch((error: unknown) => {
          console.warn(error);
          return undefined;
        }),
    initNodeText(active),
    initCompilerErrors(active),
  ]);
  fallbackDictionary = fallback;
  activeDictionary = current ?? fallback;
}

export function getLocale(): string {
  return active;
}

export function setLocale(code: string): void {
  if (LOCALE_NAMES[code] === undefined || code === active) {
    return;
  }
  // Only reload if the choice was actually persisted; otherwise the reload would revert.
  if (!writeString(STORAGE_KEY, code)) {
    return;
  }
  location.reload();
}

function lookup(dictionary: DeepPartial<Dictionary>, key: string): unknown {
  let node: unknown = dictionary;
  for (const part of key.split(".")) {
    if (typeof node !== "object") {
      return undefined;
    }
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

function resolve(key: string): string | PluralForms | undefined {
  const fromActive = lookup(activeDictionary, key);
  if (fromActive !== undefined) {
    return fromActive as string | PluralForms;
  }
  return lookup(fallbackDictionary, key) as string | PluralForms | undefined;
}

function selectPlural(forms: PluralForms, count: number): string {
  const category = new Intl.PluralRules(active).select(count);
  return forms[category] ?? forms.other ?? Object.values(forms)[0] ?? "";
}

export function t(key: TKey, parameters?: Params): string {
  const entry = resolve(key);
  if (entry === undefined) {
    return key;
  }
  if (typeof entry === "string") {
    return interpolate(active, entry, parameters);
  }
  const count = typeof parameters?.count === "number" ? parameters.count : 0;
  return interpolate(active, selectPlural(entry, count), parameters);
}
