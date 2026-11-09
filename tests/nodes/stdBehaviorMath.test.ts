import { describe, expect, it } from "vitest";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { bind, edge, graphOf, runKernel } from "../helpers/graphBuild";
import { behaviorRegistry } from "../helpers/stdRegistry";

// These exercise math-node numerics on the JS behavior backend: each computes a value and reads
// it back through a core write slot - `positionX` (a plain float slot in both phases) for a
// scalar, `position` for a vec3. Core buffers are `position` (stride 3) and `lifecycle`
// (stride 2, `[age, lifetime]`).

const reg = behaviorRegistry();

/** Runs a graph whose `out` node feeds `slot` in the update phase; returns `position`. */
function positionAfterUpdate(
  nodes: Record<string, FXBehaviorNode>,
  connections: Parameters<typeof graphOf>[1],
  slot: "position" | "positionX",
  lifecycle: readonly number[] = [0, 0],
): Float32Array {
  const graph = graphOf(nodes, connections, [bind(slot, "out", "out")]);
  return runKernel(graph, { state: { lifecycle } }).position;
}

/** Feeds float constants into the named inputs of `node`; returns the scalar written to positionX. */
function evalScalar(node: FXBehaviorNode, inputs: Readonly<Record<string, number>>): number {
  const nodes: Record<string, FXBehaviorNode> = { out: node };
  const connections = Object.entries(inputs).map(([key, value]) => {
    nodes[`in_${key}`] = reg.create("constant", { type: "float", value });
    return edge(`in_${key}`, "out", "out", key);
  });
  return positionAfterUpdate(nodes, connections, "positionX")[0];
}

describe("constant and state reads", () => {
  it("constant feeds a spawn slot as an inline literal", () => {
    // No phase param: binding to `lifetime` (a spawn-only slot) infers the spawn phase.
    const graph = graphOf(
      { c: reg.create("constant", { value: 7 }) },
      [],
      [bind("lifetime", "c", "out")],
    );
    expect(runKernel(graph, { phase: "spawn" }).lifecycle[1]).toBe(7);
  });

  it("a constant re-tuned through applyParams bakes into the next compile", () => {
    const c = reg.create("constant", { value: 2 });
    const graph = graphOf({ c }, [], [bind("lifetime", "c", "out")]);
    c.applyParams?.({ value: 5 });
    expect(runKernel(graph, { phase: "spawn" }).lifecycle[1]).toBe(5);
  });

  it("chains read-state(age) -> binary-op(divide by lifetime) -> clamp into a life ratio", () => {
    const position = positionAfterUpdate(
      {
        age: reg.create("read-state", { builtin: "PARTICLE_AGE" }),
        life: reg.create("read-state", { builtin: "PARTICLE_LIFETIME" }),
        div: reg.create("binary-op", { op: "divide" }),
        out: reg.create("clamp"),
      },
      [
        edge("age", "out", "div", "a"),
        edge("life", "out", "div", "b"),
        edge("div", "out", "out", "x"),
      ],
      "positionX",
      [3, 4],
    );
    expect(position[0]).toBeCloseTo(0.75, 6);
  });

  it("delta-time reads the update timestep (dt) into a slot", () => {
    // `delta-time` reads `dt` - an update-only kernel input - so placement inference pins the
    // graph into the update phase.
    const graph = graphOf({ dt: reg.create("delta-time") }, [], [bind("positionX", "dt", "out")]);
    expect(runKernel(graph, { dt: 0.016 }).position[0]).toBeCloseTo(0.016, 6);
  });
});

describe("generic binary math", () => {
  // `a` <- constant(vec3); `b` left unconnected with a vec3 pin value. No `type` param pins T,
  // so the pin's width must follow whatever `a`'s connection resolves to.
  it.each([
    {
      type: "binary-op",
      params: { op: "add", b: [10, 20, 30] },
      a: [1, 2, 3],
      slot: "position",
      expected: [11, 22, 33],
    },
    {
      type: "add-scaled-vector",
      params: { b: [2, 2, 2], scale: 3 },
      a: [1, 1, 1],
      slot: "position",
      expected: [7, 7, 7],
    },
    {
      type: "mix",
      params: { b: [10, 20, 30], t: 0.5 },
      a: [0, 0, 0],
      slot: "position",
      expected: [5, 10, 15],
    },
    {
      type: "dot",
      params: { b: [4, 5, 6] },
      a: [1, 2, 3],
      slot: "positionX",
      expected: [32, 0, 0],
    },
  ] as const)(
    "$type bakes an unconnected b's inline pin value at a's resolved (vec3) width",
    ({ type, params, a, slot, expected }) => {
      const position = positionAfterUpdate(
        { a: reg.create("constant", { type: "vec3", value: a }), out: reg.create(type, params) },
        [edge("a", "out", "out", "a")],
        slot,
      );
      expect([...position]).toEqual(expected);
    },
  );

  it("binary-op splats a single-number inline pin value across a vector, as a wired scalar", () => {
    const position = positionAfterUpdate(
      {
        a: reg.create("constant", { type: "vec3", value: [1, 2, 3] }),
        out: reg.create("binary-op", { op: "multiply", b: 2 }),
      },
      [edge("a", "out", "out", "a")],
      "position",
    );
    // Every component scaled - not (2, 0, 0) with the tail padded.
    expect([...position]).toEqual([2, 4, 6]);
  });

  it("binary-op multiplies by a wired scalar on either side, the scalar splatting", () => {
    const position = positionAfterUpdate(
      {
        s: reg.create("constant", { type: "float", value: 3 }),
        v: reg.create("constant", { type: "vec3", value: [1, 2, 3] }),
        out: reg.create("binary-op", { op: "multiply" }),
      },
      // The scalar on `a`, the vector on `b`: the vector still decides the width.
      [edge("s", "out", "out", "a"), edge("v", "out", "out", "b")],
      "position",
    );
    expect([...position]).toEqual([3, 6, 9]);
  });
});

describe("unary, smoothstep and remap", () => {
  it.each(["asin", "acos", "atan"] as const)("unary-op exposes inverse trig (%s)", (op) => {
    const value = evalScalar(reg.create("unary-op", { op }), { x: 0.5 });
    expect(value).toBeCloseTo(Math[op](0.5), 6);
  });

  it("smoothstep with degenerate edges (edge0 == edge1) stays finite as a hard step", () => {
    const smoothstep = (edge0: number, edge1: number, x: number): number =>
      evalScalar(reg.create("smoothstep"), { edge0, edge1, x });
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 6);
    // edge0 == edge1: no NaN; a hard threshold at the shared edge.
    expect(smoothstep(0.5, 0.5, 0.4)).toBe(0);
    expect(smoothstep(0.5, 0.5, 0.6)).toBe(1);
    expect(Number.isNaN(smoothstep(0.5, 0.5, 0.5))).toBe(false);
  });

  it("remap maps [inMin, inMax] linearly onto [outMin, outMax] without clamping", () => {
    const remap = (x: number): number =>
      evalScalar(reg.create("remap", { inMin: 2, inMax: 4, outMin: 10, outMax: 20 }), { x });
    expect(remap(2)).toBeCloseTo(10, 5);
    expect(remap(3)).toBeCloseTo(15, 5);
    expect(remap(6)).toBeCloseTo(30, 5);
  });

  it("remap applies per component on a vector input", () => {
    const position = positionAfterUpdate(
      {
        a: reg.create("constant", { type: "vec3", value: [0, 0.5, 1] }),
        out: reg.create("remap", { outMin: -1, outMax: 1 }),
      },
      [edge("a", "out", "out", "x")],
      "position",
    );
    expect([...position]).toEqual([-1, 0, 1]);
  });

  it("remap stays finite when the input range is degenerate (inMin == inMax)", () => {
    const remap = (x: number): number =>
      evalScalar(reg.create("remap", { inMin: 2, inMax: 2, outMin: 10, outMax: 20 }), { x });
    expect(remap(2)).toBe(10);
    expect(Number.isFinite(remap(3))).toBe(true);
  });
});
