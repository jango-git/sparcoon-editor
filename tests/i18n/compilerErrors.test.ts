import { describe, expect, it } from "vitest";

import { compilerErrorMessage } from "../../src/i18n/compilerErrors";
import { interpolate } from "../../src/i18n/interpolate";
import errorsEn from "../../src/i18n/locales/errors.en.json" with { type: "json" };
import errorsRu from "../../src/i18n/locales/errors.ru.json" with { type: "json" };
import errorsUk from "../../src/i18n/locales/errors.uk.json" with { type: "json" };

/**
 * `compilerErrorMessage` resolves against module state only `initCompilerErrors` (a real `fetch`)
 * populates - unavailable under vitest's Node environment (same constraint `nodeText.test.ts`
 * documents for `initNodeText`). So, mirroring that file's own approach: the locale JSON is
 * checked via static import, the pure `interpolate` substitution is exercised directly against
 * that data, and `compilerErrorMessage` itself is exercised only for its fallback path (the
 * dictionaries are empty in this test's module instance, exactly as they are before `initI18n()`
 * ever runs) - which is also the only path every not-yet-migrated code relies on today.
 */

describe('errors.*.json - the "cycle" pilot entry', () => {
  it("interpolates {nodeId} in every locale, English verbatim to FXValidation.Internal.ts's baked message", () => {
    expect(interpolate("en", errorsEn.cycle.message, { nodeId: "loopNode" })).toBe(
      'graph contains a cycle through node "loopNode"',
    );
    expect(interpolate("ru", errorsRu.cycle.message, { nodeId: "loopNode" })).toBe(
      'граф содержит цикл через ноду "loopNode"',
    );
    expect(interpolate("uk", errorsUk.cycle.message, { nodeId: "loopNode" })).toBe(
      'граф містить цикл через ноду "loopNode"',
    );
  });
});

describe("compilerErrorMessage", () => {
  it("falls back to error.message, unchanged, for a code with no dictionary entry", () => {
    // No dictionary is loaded here (that needs fetch), so every code takes this path.
    const message = compilerErrorMessage({
      code: "bad-param",
      message: "some baked English text",
      nodeId: "n1",
    });
    expect(message).toBe("some baked English text");
  });
});
