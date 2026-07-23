import { describe, expect, it } from "vitest";
import type { FXConnection, FXGraphSnapshot, FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import type {
  FXCompilerErrorCode,
  FXValidationResult,
} from "../../src/engine/core/compiler/FXCompilerError";
import type { FXValidatableTarget } from "../../src/engine/core/compiler/FXValidation.Internal";
import { validateGraph } from "../../src/engine/core/compiler/FXValidation.Internal";
import { resolveValueType } from "../../src/engine/core/socket/FXValueType";
import { FakeNode, socket } from "../helpers/fakeNodes";

const TARGET: FXValidatableTarget = {
  name: "test",
  outputs: [{ slot: "albedo", type: resolveValueType("float"), required: true }],
};

function validate(
  nodes: Record<string, FakeNode>,
  connections: readonly FXConnection[],
  outputBindings: readonly FXOutputBinding[],
): FXValidationResult {
  const snapshot: FXGraphSnapshot<FakeNode> = {
    nodes: new Map(Object.entries(nodes)),
    connections,
    outputBindings,
  };
  const graph = new FXGraph<FakeNode>();
  graph.ingest(snapshot);
  return validateGraph(graph, TARGET);
}

function hasCode(result: FXValidationResult, code: FXCompilerErrorCode): boolean {
  return result.errors.some((error) => error.code === code);
}

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

describe("validateGraph error codes", () => {
  it("unknown-node: a reachable id with no instance", () => {
    const result = validate({}, [], [bindAlbedo("ghost")]);
    expect(hasCode(result, "unknown-node")).toBe(true);
  });

  it("duplicate-input-connection: two sources into one input", () => {
    const result = validate(
      {
        p: new FakeNode({ type: "p", outputs: [socket("out")] }),
        c: new FakeNode({ type: "c", inputs: [socket("in")], outputs: [socket("out")] }),
      },
      [edge("p", "out", "c", "in"), edge("p", "out", "c", "in")],
      [bindAlbedo("c")],
    );
    expect(hasCode(result, "duplicate-input-connection")).toBe(true);
  });

  it("missing-required-input: required input left unconnected", () => {
    const result = validate(
      {
        c: new FakeNode({
          type: "c",
          inputs: [socket("in", "float", { required: true })],
          outputs: [socket("out")],
        }),
      },
      [],
      [bindAlbedo("c")],
    );
    expect(hasCode(result, "missing-required-input")).toBe(true);
  });

  it("unknown-socket: connection from a non-existent output socket", () => {
    const result = validate(
      {
        p: new FakeNode({ type: "p", outputs: [socket("out")] }),
        c: new FakeNode({ type: "c", inputs: [socket("in")], outputs: [socket("out")] }),
      },
      [edge("p", "nope", "c", "in")],
      [bindAlbedo("c")],
    );
    expect(hasCode(result, "unknown-socket")).toBe(true);
  });

  it("unknown-socket: connection into a non-existent input socket", () => {
    const result = validate(
      {
        p: new FakeNode({ type: "p", outputs: [socket("out")] }),
        c: new FakeNode({ type: "c", inputs: [socket("in")], outputs: [socket("out")] }),
      },
      // `to.socketKey` is a typo: the loop over declared inputs never sees it, so
      // without the dedicated pass the edge is silently dropped (green validate).
      [edge("p", "out", "c", "typo")],
      [bindAlbedo("c")],
    );
    expect(hasCode(result, "unknown-socket")).toBe(true);
  });

  it("does not flag a valid input-socket connection", () => {
    const result = validate(
      {
        p: new FakeNode({ type: "p", outputs: [socket("out")] }),
        c: new FakeNode({ type: "c", inputs: [socket("in")], outputs: [socket("out")] }),
      },
      [edge("p", "out", "c", "in")],
      [bindAlbedo("c")],
    );
    expect(hasCode(result, "unknown-socket")).toBe(false);
  });

  it("no type-mismatch: numeric widths coerce (vec3 into a float input)", () => {
    // Numeric widths interconvert implicitly - the compiler narrows the vec3 to its
    // first component - so this is a valid connection, not a mismatch.
    const result = validate(
      {
        p: new FakeNode({ type: "p", outputs: [socket("out", "vec3")] }),
        c: new FakeNode({ type: "c", inputs: [socket("in", "float")], outputs: [socket("out")] }),
      },
      [edge("p", "out", "c", "in")],
      [bindAlbedo("c")],
    );
    expect(hasCode(result, "type-mismatch")).toBe(false);
  });

  it("type-mismatch: feeding an opaque type (sampler2D) into a numeric input", () => {
    // A sampler has no numeric coercion, so feeding it into a float input is still a
    // genuine mismatch.
    const result = validate(
      {
        p: new FakeNode({ type: "p", outputs: [socket("out", "sampler2D")] }),
        c: new FakeNode({ type: "c", inputs: [socket("in", "float")], outputs: [socket("out")] }),
      },
      [edge("p", "out", "c", "in")],
      [bindAlbedo("c")],
    );
    expect(hasCode(result, "type-mismatch")).toBe(true);
  });

  it("cycle: two nodes feeding each other", () => {
    const result = validate(
      {
        a: new FakeNode({ type: "a", inputs: [socket("in")], outputs: [socket("out")] }),
        b: new FakeNode({ type: "b", inputs: [socket("in")], outputs: [socket("out")] }),
      },
      [edge("a", "out", "b", "in"), edge("b", "out", "a", "in")],
      [bindAlbedo("b")],
    );
    expect(hasCode(result, "cycle")).toBe(true);
  });

  it("unknown-output-slot: binding to a slot the target does not declare", () => {
    const result = validate(
      { a: new FakeNode({ type: "a", outputs: [socket("out")] }) },
      [],
      [{ slot: "emissive", from: { nodeId: "a", socketKey: "out" } }, bindAlbedo("a")],
    );
    expect(hasCode(result, "unknown-output-slot")).toBe(true);
  });

  it("duplicate-output-binding: one slot bound twice", () => {
    const result = validate(
      { a: new FakeNode({ type: "a", outputs: [socket("out")] }) },
      [],
      [bindAlbedo("a"), bindAlbedo("a")],
    );
    expect(hasCode(result, "duplicate-output-binding")).toBe(true);
  });

  it("missing-required-output: required slot left unbound", () => {
    const result = validate({ a: new FakeNode({ type: "a", outputs: [socket("out")] }) }, [], []);
    expect(hasCode(result, "missing-required-output")).toBe(true);
  });

  it("does not report problems in an unreachable branch", () => {
    const result = validate(
      {
        good: new FakeNode({ type: "good", outputs: [socket("out")] }),
        broken: new FakeNode({
          type: "broken",
          inputs: [socket("in", "float", { required: true })],
          outputs: [socket("out")],
        }),
      },
      [],
      [bindAlbedo("good")],
    );
    expect(result.ok).toBe(true);
    expect(hasCode(result, "missing-required-input")).toBe(false);
  });
});
