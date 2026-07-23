import { describe, expect, it } from "vitest";
import type { FXConnection, FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import { registerStandardBehaviorNodes } from "../../src/engine/nodes-std/index";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import {
  buildParticleSpawnKernel,
  compileBehavior,
} from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import { buildParticleBehaviorTargets } from "../../src/engine/behavior/FXParticleBehaviorTarget";

// The transform-pipeline matrix nodes are `domain: "shared"`, so they compile for the CPU
// behavior backend too - the JS lowering (`scalarize`) turns matrix mul/transpose into scalar
// reductions. There is no GLSL twin to cross-check here, so these assert the actual numbers a
// matrix transform produces in the simulation (bound to the spawn `position`).

function bind(
  slot: string,
  nodeId: string,
  socketKey: string,
  phase: FXBehaviorPhase,
): FXOutputBinding {
  return { slot, from: { nodeId, socketKey }, phase };
}
function edge(fromNode: string, fromKey: string, toNode: string, toKey: string): FXConnection {
  return {
    from: { nodeId: fromNode, socketKey: fromKey },
    to: { nodeId: toNode, socketKey: toKey },
  };
}
function registry(): FXNodeRegistry<FXBehaviorNode> {
  const r = new FXNodeRegistry<FXBehaviorNode>();
  registerStandardBehaviorNodes(r);
  return r;
}

/** Runs a spawn graph whose terminal node is bound (spawn-phase) to the core `position` slot. */
function spawnPosition(
  nodes: Map<string, FXBehaviorNode>,
  connections: readonly FXConnection[],
  terminal: string,
): [number, number, number] {
  const graph = new FXGraph<FXBehaviorNode>();
  graph.ingest({
    nodes,
    connections,
    outputBindings: [bind("position", terminal, "out", FXBehaviorPhase.SPAWN)],
  });
  const compiled = compileBehavior(graph, buildParticleBehaviorTargets());
  const spawn = buildParticleSpawnKernel(compiled);
  const buffers = { position: new Float32Array(3), lifecycle: new Float32Array(2) };
  spawn(buffers, 0, 1, compiled.spawn.bindings);
  return [buffers.position[0], buffers.position[1], buffers.position[2]];
}

/** Like {@link spawnPosition} but binds an arbitrary output socket (columns are `x/y/z/w`). */
function spawnSocket(
  nodes: Map<string, FXBehaviorNode>,
  connections: readonly FXConnection[],
  terminal: string,
  socketKey: string,
): [number, number, number] {
  const graph = new FXGraph<FXBehaviorNode>();
  graph.ingest({
    nodes,
    connections,
    outputBindings: [bind("position", terminal, socketKey, FXBehaviorPhase.SPAWN)],
  });
  const compiled = compileBehavior(graph, buildParticleBehaviorTargets());
  const spawn = buildParticleSpawnKernel(compiled);
  const buffers = { position: new Float32Array(3), lifecycle: new Float32Array(2) };
  spawn(buffers, 0, 1, compiled.spawn.bindings);
  return [buffers.position[0], buffers.position[1], buffers.position[2]];
}

function expectVec(actual: readonly number[], expected: readonly number[]): void {
  expected.forEach((v, i) => expect(actual[i]).toBeCloseTo(v, 5));
}

describe("standard behavior matrix nodes (CPU lowering)", () => {
  it("transform-point applies a translation matrix to a point (mat4 x point)", () => {
    const r = registry();
    const out = spawnPosition(
      new Map([
        ["tr", r.create("translation-matrix", { offset: [1, 2, 3] })],
        ["tp", r.create("transform-point", { p: [10, 20, 30] })],
      ]),
      [edge("tr", "out", "tp", "m")],
      "tp",
    );
    expectVec(out, [11, 22, 33]);
  });

  it("transform-direction scales a vector by a scale matrix (mat3 x vec, no translation)", () => {
    const r = registry();
    const out = spawnPosition(
      new Map([
        ["sc", r.create("scale-matrix", { scale: [2, 3, 4] })],
        ["td", r.create("transform-direction", { v: [1, 1, 1] })],
      ]),
      [edge("sc", "out", "td", "m")],
      "td",
    );
    expectVec(out, [2, 3, 4]);
  });

  it("rotation-matrix rotates a vector (mat3 x vec reduction)", () => {
    const r = registry();
    // +90 degrees about z sends x -> y.
    const out = spawnPosition(
      new Map([
        ["rot", r.create("rotation-matrix", { axis: [0, 0, 1], angle: Math.PI / 2 })],
        ["td", r.create("transform-direction", { v: [1, 0, 0] })],
      ]),
      [edge("rot", "out", "td", "m")],
      "td",
    );
    expectVec(out, [0, 1, 0]);
  });

  it("matrix-multiply composes two matrices (mat3 x mat3 reduction)", () => {
    const r = registry();
    // scale(2) * scale(3) = scale(6): [1,1,1] -> [6,6,6].
    const out = spawnPosition(
      new Map([
        ["a", r.create("scale-matrix", { scale: [2, 2, 2] })],
        ["b", r.create("scale-matrix", { scale: [3, 3, 3] })],
        ["mul", r.create("matrix-multiply", {})],
        ["td", r.create("transform-direction", { v: [1, 1, 1] })],
      ]),
      [edge("a", "out", "mul", "a"), edge("b", "out", "mul", "b"), edge("mul", "out", "td", "m")],
      "td",
    );
    expectVec(out, [6, 6, 6]);
  });

  it("transpose of a rotation is its inverse (component reindex)", () => {
    const r = registry();
    // transpose(rot_z(+90 degrees)) = rot_z(-90 degrees): x -> -y.
    const out = spawnPosition(
      new Map([
        ["rot", r.create("rotation-matrix", { axis: [0, 0, 1], angle: Math.PI / 2 })],
        ["tp", r.create("transpose", {})],
        ["td", r.create("transform-direction", { v: [1, 0, 0] })],
      ]),
      [edge("rot", "out", "tp", "m"), edge("tp", "out", "td", "m")],
      "td",
    );
    expectVec(out, [0, -1, 0]);
  });

  it("determinant of a mat3 scale matrix (cofactor formula)", () => {
    const r = registry();
    // det(diag(2,3,4)) = 24; the scalar splats across the position slot.
    const out = spawnPosition(
      new Map([
        ["sc", r.create("scale-matrix", { scale: [2, 3, 4] })],
        ["det", r.create("determinant", {})],
      ]),
      [edge("sc", "out", "det", "m")],
      "det",
    );
    expect(out[0]).toBeCloseTo(24, 4);
  });

  it("inverse of a mat3 scale matrix (adjugate / determinant)", () => {
    const r = registry();
    const out = spawnPosition(
      new Map([
        ["sc", r.create("scale-matrix", { scale: [2, 4, 8] })],
        ["inv", r.create("inverse", {})],
        ["td", r.create("transform-direction", { v: [1, 1, 1] })],
      ]),
      [edge("sc", "out", "inv", "m"), edge("inv", "out", "td", "m")],
      "td",
    );
    expectVec(out, [0.5, 0.25, 0.125]);
  });

  it("inverse of a rotation equals its transpose (mat3)", () => {
    const r = registry();
    // inverse(rot_z(+90 degrees)) sends x -> -y, same as the transpose.
    const out = spawnPosition(
      new Map([
        ["rot", r.create("rotation-matrix", { axis: [0, 0, 1], angle: Math.PI / 2 })],
        ["inv", r.create("inverse", {})],
        ["td", r.create("transform-direction", { v: [1, 0, 0] })],
      ]),
      [edge("rot", "out", "inv", "m"), edge("inv", "out", "td", "m")],
      "td",
    );
    expectVec(out, [0, -1, 0]);
  });

  it("inverse of a mat4 translation (mat4 cofactor formula)", () => {
    const r = registry();
    // inverse(translate(1,2,3)) = translate(-1,-2,-3): point (5,5,5) -> (4,3,2).
    const out = spawnPosition(
      new Map([
        ["tr", r.create("translation-matrix", { offset: [1, 2, 3] })],
        ["inv", r.create("inverse", {})],
        ["tp", r.create("transform-point", { p: [5, 5, 5] })],
      ]),
      [edge("tr", "out", "inv", "m"), edge("inv", "out", "tp", "m")],
      "tp",
    );
    expectVec(out, [4, 3, 2]);
  });

  it("combine-mat3 assembles columns in column-major order (M*ex = column 0)", () => {
    const r = registry();
    // Columns c0=(1,2,3), c1=(4,5,6), c2=(7,8,9); M*(1,0,0) picks column 0.
    const out = spawnPosition(
      new Map([
        ["cm", r.create("combine-mat3", { x: [1, 2, 3], y: [4, 5, 6], z: [7, 8, 9] })],
        ["td", r.create("transform-direction", { v: [1, 0, 0] })],
      ]),
      [edge("cm", "out", "td", "m")],
      "td",
    );
    expectVec(out, [1, 2, 3]);
  });

  it("combine-mat4 puts column 3 in the translation slot (transform-point of origin)", () => {
    const r = registry();
    // Identity rotation/scale with a (7,8,9) translation column; the origin maps to it.
    const out = spawnPosition(
      new Map([
        [
          "cm",
          r.create("combine-mat4", {
            x: [1, 0, 0, 0],
            y: [0, 1, 0, 0],
            z: [0, 0, 1, 0],
            w: [7, 8, 9, 1],
          }),
        ],
        ["tp", r.create("transform-point", { p: [0, 0, 0] })],
      ]),
      [edge("cm", "out", "tp", "m")],
      "tp",
    );
    expectVec(out, [7, 8, 9]);
  });

  it("combine-mat2 builds a mat2 that scalarizes through determinant (det of diag(2,3))", () => {
    const r = registry();
    // First (and only) mat2 producer: prove the mat2 scalarize path (det = 2*3 = 6).
    const out = spawnPosition(
      new Map([
        ["cm", r.create("combine-mat2", { x: [2, 0], y: [0, 3] })],
        ["det", r.create("determinant", {})],
      ]),
      [edge("cm", "out", "det", "m")],
      "det",
    );
    expect(out[0]).toBeCloseTo(6, 4);
  });

  it("split-mat3 recovers each column of a combine-mat3 (column-major round-trip)", () => {
    const r = registry();
    const nodes = (): Map<string, FXBehaviorNode> =>
      new Map([
        ["cm", r.create("combine-mat3", { x: [1, 2, 3], y: [4, 5, 6], z: [7, 8, 9] })],
        ["sm", r.create("split-mat3", {})],
      ]);
    const wire = [edge("cm", "out", "sm", "v")];
    expectVec(spawnSocket(nodes(), wire, "sm", "x"), [1, 2, 3]);
    expectVec(spawnSocket(nodes(), wire, "sm", "y"), [4, 5, 6]);
    expectVec(spawnSocket(nodes(), wire, "sm", "z"), [7, 8, 9]);
  });

  it("split-mat3 extracts the column of an actual rotation matrix (mat3 scalarized)", () => {
    const r = registry();
    // +90 deg about z sends the first basis column (1,0,0) to (0,1,0): that IS column 0 of the matrix.
    const out = spawnSocket(
      new Map([
        ["rot", r.create("rotation-matrix", { axis: [0, 0, 1], angle: Math.PI / 2 })],
        ["sm", r.create("split-mat3", {})],
      ]),
      [edge("rot", "out", "sm", "v")],
      "sm",
      "x",
    );
    expectVec(out, [0, 1, 0]);
  });

  it("split-mat4 extracts the translation column (column 3), padded vec4 -> position", () => {
    const r = registry();
    const out = spawnSocket(
      new Map([
        [
          "cm",
          r.create("combine-mat4", {
            x: [1, 0, 0, 0],
            y: [0, 1, 0, 0],
            z: [0, 0, 1, 0],
            w: [7, 8, 9, 1],
          }),
        ],
        ["sm", r.create("split-mat4", {})],
      ]),
      [edge("cm", "out", "sm", "v")],
      "sm",
      "w",
    );
    // The w column is (7,8,9,1); bound to the vec3 position slot it truncates to (7,8,9).
    expectVec(out, [7, 8, 9]);
  });

  it("split-mat2 extracts a column (mat2 scalarize path; vec2 padded to position)", () => {
    const r = registry();
    const out = spawnSocket(
      new Map([
        ["cm", r.create("combine-mat2", { x: [2, 3], y: [4, 5] })],
        ["sm", r.create("split-mat2", {})],
      ]),
      [edge("cm", "out", "sm", "v")],
      "sm",
      "y",
    );
    // Column 1 is (4,5); the vec2 pads with 0 into the vec3 position slot.
    expectVec(out, [4, 5, 0]);
  });

  it("normal-matrix runs the mat3(mat4) -> inverse -> transpose chain", () => {
    const r = registry();
    // A pure translation has identity rotation, so its normal matrix is identity.
    const out = spawnPosition(
      new Map([
        ["tr", r.create("translation-matrix", { offset: [9, 9, 9] })],
        ["nm", r.create("normal-matrix", {})],
        ["td", r.create("transform-direction", { v: [1, 2, 3] })],
      ]),
      [edge("tr", "out", "nm", "model"), edge("nm", "out", "td", "m")],
      "td",
    );
    expectVec(out, [1, 2, 3]);
  });
});
