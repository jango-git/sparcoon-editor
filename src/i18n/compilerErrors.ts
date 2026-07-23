/**
 * Localized text for a subset of `FXCompilerError`s, resolved by the error's stable `code` at the
 * point the editor actually displays one (`invalidFromErrors` in `render/emitterView.ts`/
 * `render/meshView.ts`) - never baked into the engine, which stays i18n-agnostic (`src/engine`
 * never imports `src/i18n`). Migrating one code here means adding its entry to
 * `locales/errors.*.json` and its construction site(s) carrying `params`; every other code keeps
 * showing its baked English `message` verbatim, via this resolver's own fallback - see
 * `compilerErrorMessage`.
 *
 * Keys are runtime strings (an `FXCompilerErrorCode`), not compile-time literals, so there is no
 * `TKey`-style check here - `tests/i18n/compilerErrors.test.ts` covers completeness for the codes
 * that have been migrated. Mirrors `nodeText.ts`'s own resolver shape (active dictionary, then the
 * English fallback dictionary, then the caller's own fallback).
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

/** Must be awaited before any resolver call - see {@link initI18n}, which calls this. */
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

/** The editor-presentable text for `error` - localized when its `code` has been migrated (an
 *  entry exists in the active or English dictionary), else `error.message` verbatim (today's
 *  baked English string) so an unmigrated code never regresses. */
export function compilerErrorMessage(error: FXCompilerError): string {
  const template = activeDictionary[error.code]?.message ?? fallbackDictionary[error.code]?.message;
  return template === undefined ? error.message : interpolate(activeLocale, template, error.params);
}
