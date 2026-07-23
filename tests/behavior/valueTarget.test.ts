import { describe, expect, it } from "vitest";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import type { FXCompiledKernel } from "../../src/engine/behavior/FXCompiledKernel";
import {
  buildParticleSpawnKernel,
  buildParticleUpdateKernel,
  compileBehavior,
  validateBehavior,
} from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { behaviorRegistry } from "../helpers/stdRegistry";
import type { FXValueSlot } from "../helpers/valueTarget";
import { buildValueBehaviorTarget, VALUES_BUFFER } from "../helpers/valueTarget";

const FLOAT = FX_VALUE_TYPES.float;
const VEC3 = FX_VALUE_TYPES.vec3;

/** progress (float) + tint (vec3) -> a 4-float `values` buffer. */
const SLOTS: readonly FXValueSlot[] = [
  { name: "progress", type: FLOAT },
  { name: "tint", type: VEC3 },
];
const targetFactory = (): ReturnType<typeof buildValueBehaviorTarget> =>
  buildValueBehaviorTarget(SLOTS);

/** One Float32Array per declared buffer, sized `stride * count`. */
function buffersFor(compiled: FXCompiledKernel, count: number): Record<string, Float32Array> {
  const buffers: Record<string, Float32Array> = {};
  for (const buffer of compiled.update.buffers) {
    buffers[buffer.name] = new Float32Array(buffer.stride * count);
  }
  return buffers;
}

/** Two `constant` update nodes writing the value slots directly. */
function valueGraph(progress: number, tint: readonly number[]): FXGraph<FXBehaviorNode> {
  const reg = behaviorRegistry();
  const p = reg.create("constant", { type: "float", value: progress, phase: "update" });
  const t = reg.create("constant", { type: "vec3", value: tint, phase: "update" });
  const graph = new FXGraph<FXBehaviorNode>();
  graph.ingest({
    nodes: new Map([
      ["p", p],
      ["t", t],
    ]),
    connections: [],
    outputBindings: [
      { slot: "progress", from: { nodeId: "p", socketKey: "out" } },
      { slot: "tint", from: { nodeId: "t", socketKey: "out" } },
    ],
  });
  return graph;
}

describe("update-only value behavior target", () => {
  it("compiles with no spawn phase", () => {
    const compiled = compileBehavior(valueGraph(0.5, [1, 0, 0]), targetFactory());
    expect(compiled.spawn).toBeUndefined();
    expect(compiled.update).toBeDefined();
  });

  it("writes the graph's values into the buffer on update()", () => {
    const compiled = compileBehavior(valueGraph(0.5, [1, 0, 0]), targetFactory());
    const update = buildParticleUpdateKernel(compiled);
    const buffers = buffersFor(compiled, 1);
    update(buffers, 1, 0.016, compiled.update.bindings);
    expect([...buffers[VALUES_BUFFER]]).toEqual([0.5, 1, 0, 0]);
  });

  it("throws a clear message when a spawn kernel is built (no spawn phase)", () => {
    const compiled = compileBehavior(valueGraph(0.5, [1, 0, 0]), targetFactory());
    expect(() => buildParticleSpawnKernel(compiled)).toThrow(/no spawn phase/);
  });

  it("a value edit recompiles (hash differs) and the buffer reflects the new value", () => {
    const first = compileBehavior(valueGraph(0.5, [1, 0, 0]), targetFactory());
    const firstBuffers = buffersFor(first, 1);
    buildParticleUpdateKernel(first)(firstBuffers, 1, 0.016, first.update.bindings);
    expect(firstBuffers[VALUES_BUFFER][0]).toBeCloseTo(0.5, 6);

    // A constant's value is an inline literal (variant A), so editing it changes the
    // structural hash -> a recompile, not a rebind.
    const edited = compileBehavior(valueGraph(0.9, [1, 0, 0]), targetFactory());
    expect(edited.hash).not.toBe(first.hash);
    const editedBuffers = buffersFor(edited, 1);
    buildParticleUpdateKernel(edited)(editedBuffers, 1, 0.016, edited.update.bindings);
    expect(editedBuffers[VALUES_BUFFER][0]).toBeCloseTo(0.9, 6);
  });

  it("rejects a reachable spawn node with phase-not-supported (no spawn phase)", () => {
    const reg = behaviorRegistry();
    const s = reg.create("constant", { type: "float", value: 1, phase: "spawn" });
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes: new Map([["s", s]]),
      connections: [],
      outputBindings: [{ slot: "progress", from: { nodeId: "s", socketKey: "out" } }],
    });

    const result = validateBehavior(graph, targetFactory());
    expect(result.ok).toBe(false);
    const error = result.errors.find((e) => e.code === "phase-not-supported");
    expect(error?.nodeId).toBe("s");
  });

  it("refuses to compile (throws) when a spawn node is placed on the update-only target", () => {
    // The FXSimulation.live gate returned "invalid" (no recompile) for this graph; the live
    // invariant is that compileBehavior refuses it outright while validateBehavior surfaces why.
    const reg = behaviorRegistry();
    const s = reg.create("constant", { type: "float", value: 1, phase: "spawn" });
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes: new Map([["s", s]]),
      connections: [],
      outputBindings: [{ slot: "progress", from: { nodeId: "s", socketKey: "out" } }],
    });

    expect(() => compileBehavior(graph, targetFactory())).toThrow();
    expect(
      validateBehavior(graph, targetFactory()).errors.some((e) => e.code === "phase-not-supported"),
    ).toBe(true);
  });
});
