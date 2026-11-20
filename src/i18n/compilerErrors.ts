/**
 * Localized text for `FXCompilerError`s, resolved by `code` where the editor displays an error
 * (`render/emitterView.ts`, `render/meshView.ts`). The engine stays free of i18n. A code without
 * an entry in `locales/errors.*.json` shows its English `message`. Keys are runtime strings, so
 * `tests/i18n/compilerErrors.test.ts` checks completeness.
 */

import type { FXCompilerError } from "../engine/core/compiler/FXCompilerError";
import { interpolate } from "./interpolate";

interface CompilerErrorEntry {
  readonly message: string;
}

type CompilerErrorDictionary = Readonly<Record<string, CompilerErrorEntry>>;

const DEFAULT_LOCALE = "en";

let activeLocale = DEFAULT_LOCALE;
let activeDictionary: CompilerErrorDictionary = {};
let fallbackDictionary: CompilerErrorDictionary = {};

async function loadCompilerErrorDictionary(code: string): Promise<CompilerErrorDictionary> {
  const url = new URL(`locales/errors.${code}.json`, import.meta.url);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load compiler-error text "${code}": ${response.status}`);
  }
  return (await response.json()) as CompilerErrorDictionary;
}

/** Must be awaited before any resolver call - see {@link initGraphText}, which calls this. */
export async function initCompilerErrors(locale: string): Promise<void> {
  const [fallback, current] = await Promise.all([
    loadCompilerErrorDictionary(DEFAULT_LOCALE),
    locale === DEFAULT_LOCALE
      ? Promise.resolve(undefined)
      : loadCompilerErrorDictionary(locale).catch((error: unknown) => {
          console.warn(error);
          return undefined;
        }),
  ]);
  activeLocale = locale;
  fallbackDictionary = fallback;
  activeDictionary = current ?? fallback;
}

/** The text for `error`: the localized entry for its `code` (active, then English dictionary),
 *  else `error.message`. */
export function compilerErrorMessage(error: FXCompilerError): string {
  const template = activeDictionary[error.code]?.message ?? fallbackDictionary[error.code]?.message;
  return template === undefined ? error.message : interpolate(activeLocale, template, error.params);
}
