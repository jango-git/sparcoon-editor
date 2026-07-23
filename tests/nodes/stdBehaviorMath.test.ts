import { describe, expect, it } from "vitest";
import type { FXConnection, FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import { registerStandardBehaviorNodes } from "../../src/engine/nodes-std/index";
import { FX_BEHAVIOR_MATH_NODES } from "../../src/engine/nodes-std/behavior/math";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import {
  buildParticleSpawnKernel,
  buildParticleUpdateKernel,
  compileParticleBehavior,
  previewParticleBehaviorHash,
} from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";

// These exercise math-node numerics: each computes a scalar and reads it back through
// the core `positionX` write slot (a plain float slot in both phases - not a velocity or
// scale value). Core buffers are `position` (stride 3) and `lifecycle` (stride 2,
// `[age, lifetime]`); the written scalar is `position[0]`.

function bind(slot: string, nodeId: string, socketKey: string): FXOutputBinding {
  return { slot, from: { nodeId, socketKey } };
}

function edge(fromNode: string, fromKey: string, toNode: string, toKey: string): FXConnection {
  return {
    from: { nodeId: fromNode, socketKey: fromKey },
    to: { nodeId: toNode, socketKey: toKey },
  };
}

/** Core buffers (one particle): `position` vec3 + `lifecycle` `[age, lifetime]`. */
function coreBuffers(age = 0, lifetime = 0): Record<string, Float32Array> {
  return { position: new Float32Array(3), lifecycle: Float32Array.from([age, lifetime]) };
}

function registry(): FXNodeRegistry<FXBehaviorNode> {
  const r = new FXNodeRegistry<FXBehaviorNode>();
  registerStandardBehaviorNodes(r);
  return r;
}

describe("standard behavior math - registration & compilation", () => {
  it("registers every math definition once", () => {
    const r = registry();
    for (const def of FX_BEHAVIOR_MATH_NODES) {
      expect(r.has(def.type)).toBe(true);
    }
  });

  it("every definition describes JSON-serializably", () => {
    for (const def of FX_BEHAVIOR_MATH_NODES) {
      expect(() => JSON.stringify(def.describe())).not.toThrow();
    }
  });

  it("constant feeds a spawn slot as a live binding", () => {
    const r = registry();
    // No phase param: binding to `lifetime` (a spawn-only slot) infers the spawn phase.
    const c = r.create("constant", { value: 7 });
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes: new Map([["c", c]]),
      connections: [],
      outputBindings: [bind("lifetime", "c", "out")],
    });

    const compiled = compileParticleBehavior(graph);
    const spawn = buildParticleSpawnKernel(compiled);
    const buffers = coreBuffers();
    spawn(buffers, 0, 1, compiled.spawn.bindings);
    expect(buffers.lifecycle[1]).toBe(7); // lifecycle = [age, lifetime]
  });

  it("chains read-state(age) -> binary-op(divide by lifetime) -> clamp into a life ratio", () => {
    const r = registry();
    // age / lifetime, then clamp to [0,1] - an explicit life-ratio.
    // All default to phase "param" -> "update"; the whole chain runs in update.
    const nodes = new Map<string, FXBehaviorNode>([
      ["age", r.create("read-state", { builtin: "PARTICLE_AGE" })],
      ["life", r.create("read-state", { builtin: "PARTICLE_LIFETIME" })],
      ["div", r.create("binary-op", { op: "divide" })],
      ["clamp", r.create("clamp", undefined)],
    ]);
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes,
      connections: [
        edge("age", "out", "div", "a"),
        edge("life", "out", "div", "b"),
        edge("div", "out", "clamp", "x"),
      ],
      outputBindings: [bind("positionX", "clamp", "out")],
    });

    const compiled = compileParticleBehavior(graph);
    const update = buildParticleUpdateKernel(compiled);
    const buffers = coreBuffers(3, 4);
    update(buffers, 1, 0.016, compiled.update.bindings);
    expect(buffers.position[0]).toBeCloseTo(0.75, 6);
  });

  it("delta-time reads the update timestep (dt) into a slot", () => {
    const r = registry();
    // `delta-time` reads `dt` - an update-only kernel input - so placement inference
    // pins the graph into the update phase; the kernel's 3rd arg (dt) lands in positionX.
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes: new Map([["dt", r.create("delta-time", undefined)]]),
      connections: [],
      outputBindings: [bind("positionX", "dt", "out")],
    });

    const compiled = compileParticleBehavior(graph);
    const update = buildParticleUpdateKernel(compiled);
    const buffers = coreBuffers();
    update(buffers, 1, 0.016, compiled.update.bindings);
    expect(buffers.position[0]).toBeCloseTo(0.016, 6);
  });

  it("re-tuning a constant moves the hash (inline literal -> recompile)", () => {
    const r = registry();
    const c = r.create("constant", { value: 2 });
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes: new Map([["c", c]]),
      connections: [],
      outputBindings: [bind("lifetime", "c", "out")], // spawn-only slot -> spawn phase
    });

    // The constant's value is an inline literal now (variant A), so editing it recompiles.
    const before = previewParticleBehaviorHash(graph);
    c.applyParams?.({ value: 5 });
    expect(previewParticleBehaviorHash(graph)).not.toBe(before);

    // A fresh compile bakes the new value into the spawn kernel.
    const compiled = compileParticleBehavior(graph);
    const spawn = buildParticleSpawnKernel(compiled);
    const buffers = coreBuffers();
    spawn(buffers, 0, 1, compiled.spawn.bindings);
    expect(buffers.lifecycle[1]).toBe(5); // lifecycle = [age, lifetime]
  });

  it("changing binary-op's operation moves the structural hash", () => {
    const r = registry();
    const add = r.create("binary-op", { op: "add" });
    const mul = r.create("binary-op", { op: "multiply" });
    expect(add.cacheKey?.()).not.toBe(mul.cacheKey?.());
  });

  it("binary-op bakes an unconnected b's inline pin value at a's resolved (vec3) width", () => {
    const r = registry();
    // a <- constant(vec3); b left unconnected, overridden to a vec3 pin value - no `type`
    // param pins T here, so the width must follow whatever a's connection resolves to.
    const nodes = new Map<string, FXBehaviorNode>([
      ["a", r.create("constant", { type: "vec3", value: [1, 2, 3] })],
      ["add", r.create("binary-op", { op: "add", b: [10, 20, 30] })],
    ]);
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes,
      connections: [edge("a", "out", "add", "a")],
      outputBindings: [bind("position", "add", "out")],
    });
    const compiled = compileParticleBehavior(graph);
    const update = buildParticleUpdateKernel(compiled);
    const buffers = coreBuffers();
    update(buffers, 1, 0.016, compiled.update.bindings);
    expect([...buffers.position]).toEqual([11, 22, 33]);
  });

  it("add-scaled-vector computes out = a + b * scale, b unconnected at the resolved width", () => {
    const r = registry();
    const nodes = new Map<string, FXBehaviorNode>([
      ["a", r.create("constant", { type: "vec3", value: [1, 1, 1] })],
      ["madd", r.create("add-scaled-vector", { b: [2, 2, 2], scale: 3 })],
    ]);
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes,
      connections: [edge("a", "out", "madd", "a")],
      outputBindings: [bind("position", "madd", "out")],
    });
    const compiled = compileParticleBehavior(graph);
    const update = buildParticleUpdateKernel(compiled);
    const buffers = coreBuffers();
    update(buffers, 1, 0.016, compiled.update.bindings);
    expect([...buffers.position]).toEqual([7, 7, 7]);
  });

  it("mix bakes an unconnected b's inline pin value at a's resolved (vec3) width", () => {
    const r = registry();
    const nodes = new Map<string, FXBehaviorNode>([
      ["a", r.create("constant", { type: "vec3", value: [0, 0, 0] })],
      ["mix", r.create("mix", { b: [10, 20, 30], t: 0.5 })],
    ]);
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes,
      connections: [edge("a", "out", "mix", "a")],
      outputBindings: [bind("position", "mix", "out")],
    });
    const compiled = compileParticleBehavior(graph);
    const update = buildParticleUpdateKernel(compiled);
    const buffers = coreBuffers();
    update(buffers, 1, 0.016, compiled.update.bindings);
    expect([...buffers.position]).toEqual([5, 10, 15]);
  });

  it("dot bakes an unconnected b's inline pin value at a's resolved (vec3) width", () => {
    const r = registry();
    const nodes = new Map<string, FXBehaviorNode>([
      ["a", r.create("constant", { type: "vec3", value: [1, 2, 3] })],
      ["dot", r.create("dot", { b: [4, 5, 6] })],
    ]);
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes,
      connections: [edge("a", "out", "dot", "a")],
      outputBindings: [bind("positionX", "dot", "out")],
    });
    const compiled = compileParticleBehavior(graph);
    const update = buildParticleUpdateKernel(compiled);
    const buffers = coreBuffers();
    update(buffers, 1, 0.016, compiled.update.bindings);
    expect(buffers.position[0]).toBe(32); // 1*4 + 2*5 + 3*6
  });

  /** constant(value) -> unary-op(op) -> positionX; returns the written scalar. */
  function evalUnary(op: string, value: number): number {
    const r = registry();
    const nodes = new Map<string, FXBehaviorNode>([
      ["c", r.create("constant", { value, type: "float" })],
      ["u", r.create("unary-op", { op })],
    ]);
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes,
      connections: [edge("c", "out", "u", "x")],
      outputBindings: [bind("positionX", "u", "out")],
    });
    const compiled = compileParticleBehavior(graph);
    const update = buildParticleUpdateKernel(compiled);
    const buffers = coreBuffers();
    update(buffers, 1, 0.016, compiled.update.bindings);
    return buffers.position[0];
  }

  it("unary-op exposes inverse trig (asin/acos/atan) (N6)", () => {
    expect(evalUnary("asin", 0.5)).toBeCloseTo(Math.asin(0.5), 6);
    expect(evalUnary("acos", 0.5)).toBeCloseTo(Math.acos(0.5), 6);
    expect(evalUnary("atan", 0.5)).toBeCloseTo(Math.atan(0.5), 6);
  });

  /** constant edges/x wired into a smoothstep node; returns the written scalar. */
  function evalSmoothstep(edge0: number, edge1: number, x: number): number {
    const r = registry();
    const nodes = new Map<string, FXBehaviorNode>([
      ["e0", r.create("constant", { value: edge0, type: "float" })],
      ["e1", r.create("constant", { value: edge1, type: "float" })],
      ["x", r.create("constant", { value: x, type: "float" })],
      ["ss", r.create("smoothstep", undefined)],
    ]);
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes,
      connections: [
        edge("e0", "out", "ss", "edge0"),
        edge("e1", "out", "ss", "edge1"),
        edge("x", "out", "ss", "x"),
      ],
      outputBindings: [bind("positionX", "ss", "out")],
    });
    const compiled = compileParticleBehavior(graph);
    const update = buildParticleUpdateKernel(compiled);
    const buffers = coreBuffers();
    update(buffers, 1, 0.016, compiled.update.bindings);
    return buffers.position[0];
  }

  it("smoothstep with degenerate edges (edge0 == edge1) stays finite as a hard step (N4)", () => {
    // Non-degenerate sanity.
    expect(evalSmoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 6);
    // edge0 == edge1: no NaN; a hard threshold at the shared edge.
    expect(evalSmoothstep(0.5, 0.5, 0.4)).toBe(0);
    expect(evalSmoothstep(0.5, 0.5, 0.6)).toBe(1);
    expect(Number.isNaN(evalSmoothstep(0.5, 0.5, 0.5))).toBe(false);
  });
});
