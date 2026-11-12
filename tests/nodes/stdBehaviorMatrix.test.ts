import { Euler, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import type { FXConnection } from "../../src/engine/core/FXGraph";
import { bind, edge, graphOf, runKernel } from "../helpers/graphBuild";
import { behaviorRegistry } from "../helpers/stdRegistry";

// The transform-pipeline matrix nodes are `domain: "shared"`, so they compile for the CPU
// behavior backend too - the JS lowering (`scalarize`) turns matrix mul/transpose into scalar
// reductions. These assert the actual numbers a matrix transform produces in the simulation
// (bound to the spawn `position`).

const reg = behaviorRegistry();

/** Runs a spawn graph whose `terminal.socketKey` is bound (spawn-phase) to the core `position`. */
function spawnPosition(
  nodes: Readonly<Record<string, FXBehaviorNode>>,
  connections: readonly FXConnection[],
  terminal: string,
  socketKey = "out",
): [number, number, number] {
  const graph = graphOf(nodes, connections, [bind("position", terminal, socketKey, "spawn")]);
  const [x, y, z] = runKernel(graph, { phase: "spawn" }).position;
  return [x, y, z];
}

function expectVec(actual: readonly number[], expected: readonly number[]): void {
  expected.forEach((v, i) => expect(actual[i]).toBeCloseTo(v, 5));
}

describe("standard behavior matrix nodes (CPU lowering)", () => {
  it("transform-point applies a translation matrix to a point (mat4 x point)", () => {
    const out = spawnPosition(
      {
        tr: reg.create("translation-matrix", { offset: [1, 2, 3] }),
        tp: reg.create("transform-point", { p: [10, 20, 30] }),
      },
      [edge("tr", "out", "tp", "m")],
      "tp",
    );
    expectVec(out, [11, 22, 33]);
  });

  it("transform-direction scales a vector by a scale matrix (mat3 x vec, no translation)", () => {
    const out = spawnPosition(
      {
        sc: reg.create("scale-matrix", { scale: [2, 3, 4] }),
        td: reg.create("transform-direction", { v: [1, 1, 1] }),
      },
      [edge("sc", "out", "td", "m")],
      "td",
    );
    expectVec(out, [2, 3, 4]);
  });

  it("rotation-matrix rotates a vector (mat3 x vec reduction)", () => {
    // +90 degrees about z sends x -> y.
    const out = spawnPosition(
      {
        rot: reg.create("rotation-matrix", { axis: [0, 0, 1], angle: Math.PI / 2 }),
        td: reg.create("transform-direction", { v: [1, 0, 0] }),
      },
      [edge("rot", "out", "td", "m")],
      "td",
    );
    expectVec(out, [0, 1, 0]);
  });

  it("matrix-multiply composes two matrices (mat3 x mat3 reduction)", () => {
    // scale(2) * scale(3) = scale(6): [1,1,1] -> [6,6,6].
    const out = spawnPosition(
      {
        a: reg.create("scale-matrix", { scale: [2, 2, 2] }),
        b: reg.create("scale-matrix", { scale: [3, 3, 3] }),
        mul: reg.create("matrix-multiply"),
        td: reg.create("transform-direction", { v: [1, 1, 1] }),
      },
      [edge("a", "out", "mul", "a"), edge("b", "out", "mul", "b"), edge("mul", "out", "td", "m")],
      "td",
    );
    expectVec(out, [6, 6, 6]);
  });

  it("transpose of a rotation is its inverse (component reindex)", () => {
    // transpose(rot_z(+90 degrees)) = rot_z(-90 degrees): x -> -y.
    const out = spawnPosition(
      {
        rot: reg.create("rotation-matrix", { axis: [0, 0, 1], angle: Math.PI / 2 }),
        tp: reg.create("transpose"),
        td: reg.create("transform-direction", { v: [1, 0, 0] }),
      },
      [edge("rot", "out", "tp", "m"), edge("tp", "out", "td", "m")],
      "td",
    );
    expectVec(out, [0, -1, 0]);
  });

  it("determinant of a mat3 scale matrix (cofactor formula)", () => {
    // det(diag(2,3,4)) = 24; the scalar splats across the position slot.
    const out = spawnPosition(
      { sc: reg.create("scale-matrix", { scale: [2, 3, 4] }), det: reg.create("determinant") },
      [edge("sc", "out", "det", "m")],
      "det",
    );
    expect(out[0]).toBeCloseTo(24, 4);
  });

  it("inverse of a mat3 scale matrix (adjugate / determinant)", () => {
    const out = spawnPosition(
      {
        sc: reg.create("scale-matrix", { scale: [2, 4, 8] }),
        inv: reg.create("inverse"),
        td: reg.create("transform-direction", { v: [1, 1, 1] }),
      },
      [edge("sc", "out", "inv", "m"), edge("inv", "out", "td", "m")],
      "td",
    );
    expectVec(out, [0.5, 0.25, 0.125]);
  });

  it("inverse of a rotation equals its transpose (mat3)", () => {
    // inverse(rot_z(+90 degrees)) sends x -> -y, same as the transpose.
    const out = spawnPosition(
      {
        rot: reg.create("rotation-matrix", { axis: [0, 0, 1], angle: Math.PI / 2 }),
        inv: reg.create("inverse"),
        td: reg.create("transform-direction", { v: [1, 0, 0] }),
      },
      [edge("rot", "out", "inv", "m"), edge("inv", "out", "td", "m")],
      "td",
    );
    expectVec(out, [0, -1, 0]);
  });

  it("inverse of a mat4 translation (mat4 cofactor formula)", () => {
    // inverse(translate(1,2,3)) = translate(-1,-2,-3): point (5,5,5) -> (4,3,2).
    const out = spawnPosition(
      {
        tr: reg.create("translation-matrix", { offset: [1, 2, 3] }),
        inv: reg.create("inverse"),
        tp: reg.create("transform-point", { p: [5, 5, 5] }),
      },
      [edge("tr", "out", "inv", "m"), edge("inv", "out", "tp", "m")],
      "tp",
    );
    expectVec(out, [4, 3, 2]);
  });

  it("combine-mat3 assembles columns in column-major order (M*ex = column 0)", () => {
    // Columns c0=(1,2,3), c1=(4,5,6), c2=(7,8,9); M*(1,0,0) picks column 0.
    const out = spawnPosition(
      {
        cm: reg.create("combine-mat3", { x: [1, 2, 3], y: [4, 5, 6], z: [7, 8, 9] }),
        td: reg.create("transform-direction", { v: [1, 0, 0] }),
      },
      [edge("cm", "out", "td", "m")],
      "td",
    );
    expectVec(out, [1, 2, 3]);
  });

  it("combine-mat4 puts column 3 in the translation slot (transform-point of origin)", () => {
    // Identity rotation/scale with a (7,8,9) translation column; the origin maps to it.
    const out = spawnPosition(
      {
        cm: reg.create("combine-mat4", {
          x: [1, 0, 0, 0],
          y: [0, 1, 0, 0],
          z: [0, 0, 1, 0],
          w: [7, 8, 9, 1],
        }),
        tp: reg.create("transform-point", { p: [0, 0, 0] }),
      },
      [edge("cm", "out", "tp", "m")],
      "tp",
    );
    expectVec(out, [7, 8, 9]);
  });

  it("combine-mat2 builds a mat2 that scalarizes through determinant (det of diag(2,3))", () => {
    // First (and only) mat2 producer: prove the mat2 scalarize path (det = 2*3 = 6).
    const out = spawnPosition(
      { cm: reg.create("combine-mat2", { x: [2, 0], y: [0, 3] }), det: reg.create("determinant") },
      [edge("cm", "out", "det", "m")],
      "det",
    );
    expect(out[0]).toBeCloseTo(6, 4);
  });

  it("split-mat3 recovers each column of a combine-mat3 (column-major round-trip)", () => {
    const nodes = (): Record<string, FXBehaviorNode> => ({
      cm: reg.create("combine-mat3", { x: [1, 2, 3], y: [4, 5, 6], z: [7, 8, 9] }),
      sm: reg.create("split-mat3"),
    });
    const wire = [edge("cm", "out", "sm", "v")];
    expectVec(spawnPosition(nodes(), wire, "sm", "x"), [1, 2, 3]);
    expectVec(spawnPosition(nodes(), wire, "sm", "y"), [4, 5, 6]);
    expectVec(spawnPosition(nodes(), wire, "sm", "z"), [7, 8, 9]);
  });

  it("split-mat3 extracts the column of an actual rotation matrix (mat3 scalarized)", () => {
    // +90 deg about z sends the first basis column (1,0,0) to (0,1,0): that IS column 0 of the matrix.
    const out = spawnPosition(
      {
        rot: reg.create("rotation-matrix", { axis: [0, 0, 1], angle: Math.PI / 2 }),
        sm: reg.create("split-mat3"),
      },
      [edge("rot", "out", "sm", "v")],
      "sm",
      "x",
    );
    expectVec(out, [0, 1, 0]);
  });

  it("split-mat4 extracts the translation column (column 3), padded vec4 -> position", () => {
    const out = spawnPosition(
      {
        cm: reg.create("combine-mat4", {
          x: [1, 0, 0, 0],
          y: [0, 1, 0, 0],
          z: [0, 0, 1, 0],
          w: [7, 8, 9, 1],
        }),
        sm: reg.create("split-mat4"),
      },
      [edge("cm", "out", "sm", "v")],
      "sm",
      "w",
    );
    // The w column is (7,8,9,1); bound to the vec3 position slot it truncates to (7,8,9).
    expectVec(out, [7, 8, 9]);
  });

  it("split-mat2 extracts a column (mat2 scalarize path; vec2 padded to position)", () => {
    const out = spawnPosition(
      { cm: reg.create("combine-mat2", { x: [2, 3], y: [4, 5] }), sm: reg.create("split-mat2") },
      [edge("cm", "out", "sm", "v")],
      "sm",
      "y",
    );
    // Column 1 is (4,5); the vec2 pads with 0 into the vec3 position slot.
    expectVec(out, [4, 5, 0]);
  });

  it("normal-matrix runs the mat3(mat4) -> inverse -> transpose chain", () => {
    // A pure translation has identity rotation, so its normal matrix is identity.
    const out = spawnPosition(
      {
        tr: reg.create("translation-matrix", { offset: [9, 9, 9] }),
        nm: reg.create("normal-matrix"),
        td: reg.create("transform-direction", { v: [1, 2, 3] }),
      },
      [edge("tr", "out", "nm", "model"), edge("nm", "out", "td", "m")],
      "td",
    );
    expectVec(out, [1, 2, 3]);
  });

  it("euler-to-rotation matches Three's XYZ Euler rotation", () => {
    const angles = [0.3, -0.7, 1.1] as const;
    const out = spawnPosition(
      {
        e: reg.create("euler-to-rotation", { angles: [...angles] }),
        td: reg.create("transform-direction", { v: [1, 2, 3] }),
      },
      [edge("e", "out", "td", "m")],
      "td",
    );
    const expected = new Vector3(1, 2, 3).applyEuler(new Euler(...angles, "XYZ"));
    expectVec(out, expected.toArray());
  });

  it("matrix-to-mat3 keeps a mat4's rotation/scale block and drops its translation", () => {
    const out = spawnPosition(
      {
        cm: reg.create("combine-mat4", {
          x: [2, 0, 0, 0],
          y: [0, 3, 0, 0],
          z: [0, 0, 4, 0],
          w: [7, 8, 9, 1],
        }),
        m3: reg.create("matrix-to-mat3"),
        td: reg.create("transform-direction", { v: [1, 1, 1] }),
      },
      [edge("cm", "out", "m3", "m"), edge("m3", "out", "td", "m")],
      "td",
    );
    expectVec(out, [2, 3, 4]);
  });
});
