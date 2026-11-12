import { describe, expect, it } from "vitest";

import uiEn from "../../src/i18n/locales/en.json" with { type: "json" };
import errorsEn from "../../src/i18n/locales/errors.en.json" with { type: "json" };
import errorsRu from "../../src/i18n/locales/errors.ru.json" with { type: "json" };
import errorsUk from "../../src/i18n/locales/errors.uk.json" with { type: "json" };
import nodesEn from "../../src/i18n/locales/nodes.en.json" with { type: "json" };
import nodesRu from "../../src/i18n/locales/nodes.ru.json" with { type: "json" };
import nodesUk from "../../src/i18n/locales/nodes.uk.json" with { type: "json" };
import uiRu from "../../src/i18n/locales/ru.json" with { type: "json" };
import uiUk from "../../src/i18n/locales/uk.json" with { type: "json" };

/**
 * Every translated dictionary carries exactly the English key set, and each entry names the same
 * `{placeholders}` as its English twin - so a string added in one locale only, or a placeholder
 * dropped in translation, fails here instead of silently falling back (or rendering a raw
 * `{name}`) at runtime. `searchTags` are skipped: they are per-locale search aliases, merged with
 * the English ones rather than translated one-to-one (see `nodeSearchTags`).
 */

const PLURAL_CATEGORIES: ReadonlySet<string> = new Set([
  "zero",
  "one",
  "two",
  "few",
  "many",
  "other",
]);

/** Flattens a dictionary to `dotted.key -> sorted placeholder names`. */
function placeholdersByKey(dictionary: unknown): Map<string, string> {
  const result = new Map<string, string>();
  const collect = (text: string): string[] =>
    [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
  const visit = (value: unknown, key: string): void => {
    if (typeof value === "string") {
      result.set(key, [...new Set(collect(value))].sort().join(","));
      return;
    }
    if (typeof value !== "object" || !value) {
      result.set(key, `<${typeof value}>`);
      return;
    }
    const entries = Object.entries(value);
    // A plural-forms object is one entry: each locale picks its own set of categories.
    if (entries.length > 0 && entries.every(([name]) => PLURAL_CATEGORIES.has(name))) {
      const names = entries.flatMap(([, form]) => (typeof form === "string" ? collect(form) : []));
      result.set(key, [...new Set(names)].sort().join(","));
      return;
    }
    for (const [name, child] of entries) {
      if (name !== "searchTags") {
        visit(child, key === "" ? name : `${key}.${name}`);
      }
    }
  };
  visit(dictionary, "");
  return result;
}

const FAMILIES = [
  { name: "UI (en/ru/uk.json)", en: uiEn, translations: { ru: uiRu, uk: uiUk } },
  { name: "errors.*.json", en: errorsEn, translations: { ru: errorsRu, uk: errorsUk } },
  { name: "nodes.*.json", en: nodesEn, translations: { ru: nodesRu, uk: nodesUk } },
];

describe("locale dictionaries stay in parity with English", () => {
  for (const family of FAMILIES) {
    for (const [locale, dictionary] of Object.entries(family.translations)) {
      it(`${family.name}: ${locale} has the English keys and placeholders`, () => {
        const english = placeholdersByKey(family.en);
        const translated = placeholdersByKey(dictionary);
        expect(english.size).toBeGreaterThan(0);

        const missing = [...english.keys()].filter((key) => !translated.has(key));
        const extra = [...translated.keys()].filter((key) => !english.has(key));
        const placeholderDrift = [...english]
          .filter(([key, names]) => translated.has(key) && translated.get(key) !== names)
          .map(([key, names]) => `${key}: en {${names}} vs ${locale} {${translated.get(key)}}`);

        expect({ missing, extra, placeholderDrift }).toEqual({
          missing: [],
          extra: [],
          placeholderDrift: [],
        });
      });
    }
  }
});
