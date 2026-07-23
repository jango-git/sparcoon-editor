import { describe, expect, it } from "vitest";
import type { FXConnection, FXGraphSnapshot, FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import type { FXValidatableTarget } from "../../src/engine/core/compiler/FXValidation.Internal";
import { validateGraph } from "../../src/engine/core/compiler/FXValidation.Internal";
import { resolveValueType } from "../../src/engine/core/socket/FXValueType";
import { FakeNode, socket } from "../helpers/fakeNodes";
import { interpolate } from "../../src/i18n/interpolate";
import { compilerErrorMessage } from "../../src/i18n/compilerErrors";
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

const TARGET: FXValidatableTarget = {
  name: "test",
  outputs: [{ slot: "albedo", type: resolveValueType("float"), required: true }],
};

function edge(fromNode: string, fromKey: string, toNode: string, toKey: string): FXConnection {
  return {
    from: { nodeId: fromNode, socketKey: fromKey },
    to: { nodeId: toNode, socketKey: toKey },
  };
}

const bindAlbedo = (nodeId: string, socketKey = "out"): FXOutputBinding => ({
  slot: "albedo",
  from: { nodeId, socketKey },
});

describe('errors.*.json - the "cycle" pilot entry', () => {
  it("carries an {nodeId} placeholder in every locale", () => {
    for (const dictionary of [errorsEn, errorsRu, errorsUk]) {
      expect(dictionary.cycle.message).toContain("{nodeId}");
    }
  });

  it("the English entry matches FXValidation.Internal.ts's baked message verbatim", () => {
    expect(errorsEn.cycle.message).toBe('graph contains a cycle through node "{nodeId}"');
  });

  it("interpolates {nodeId} correctly in en/ru/uk", () => {
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
    // Every code besides "cycle" is still unmigrated - this is the safety net they all rely on.
    const message = compilerErrorMessage({
      code: "bad-param",
      message: "some baked English text",
      nodeId: "n1",
    });
    expect(message).toBe("some baked English text");
  });
});

describe("a real cycle carries params matching its baked message (FXValidation.Internal.ts)", () => {
  it("cycle: two nodes feeding each other", () => {
    const snapshot: FXGraphSnapshot<FakeNode> = {
      nodes: new Map(
        Object.entries({
          a: new FakeNode({ type: "a", inputs: [socket("in")], outputs: [socket("out")] }),
          b: new FakeNode({ type: "b", inputs: [socket("in")], outputs: [socket("out")] }),
        }),
      ),
      connections: [edge("a", "out", "b", "in"), edge("b", "out", "a", "in")],
      outputBindings: [bindAlbedo("b")],
    };
    const graph = new FXGraph<FakeNode>();
    graph.ingest(snapshot);
    const result = validateGraph(graph, TARGET);

    const cycleError = result.errors.find((error) => error.code === "cycle");
    expect(cycleError).toBeDefined();
    expect(cycleError?.params).toEqual({ nodeId: cycleError?.nodeId });
    // The params-driven interpolation reproduces the same node id the baked message names.
    expect(cycleError?.message).toContain(`"${cycleError?.params?.["nodeId"]}"`);
  });
});
