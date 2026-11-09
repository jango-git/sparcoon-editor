import { describe, expect, it } from "vitest";
import { FX_RENDER_MATRIX_NODES, resolveAlignAxes } from "../../src/engine/nodes-std/render/matrix";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import { FX_PARTICLE_TARGET } from "../../src/engine/render/target/FXParticleRenderTarget";
import { bind, edge, graphOf } from "../helpers/graphBuild";
import { behaviorRegistry, renderRegistry } from "../helpers/stdRegistry";

// Matrix nodes build/compose/apply mat2/mat3/mat4 transforms. These graphs are hand-built (the
// generic contract harness cannot synthesize matrix inputs from a `constant`), binding a
// matrix-derived value to a real output slot so the whole chain compiles to GLSL. The shared
// nodes' numerics are asserted on the CPU backend in stdBehaviorMatrix.test.ts; here the
// observable is GLSL placement and structure.

const reg = renderRegistry();

describe("standard render matrix nodes", () => {
  const compiler = new FXCompilerBaseline();

  it("matrix nodes are shared except the render-only view-matrix nodes", () => {
    const behaviorReg = behaviorRegistry();
    // The behavior target has no camera, so view-matrix / inverse-view-matrix / align-to-velocity
    // (it also faces a camera axis) are render-only.
    const renderOnly = new Set(["view-matrix", "inverse-view-matrix", "align-to-velocity"]);
    for (const def of FX_RENDER_MATRIX_NODES) {
      expect(reg.has(def.type)).toBe(true);
      // world-matrix reads `modelMatrix` on both sides; the shared ones live in both registries.
      expect(behaviorReg.has(def.type)).toBe(!renderOnly.has(def.type));
    }
  });

  it("rotation-matrix drives transform-direction into a vertex slot (mat3 in the vertex stage)", () => {
    const graph = graphOf(
      {
        rot: reg.create("rotation-matrix", { axis: [0, 1, 0], angle: 1 }),
        td: reg.create("transform-direction", { v: [1, 0, 0] }),
        compose: reg.create("compose-transform"),
        col: reg.create("constant", { type: "color", value: [1, 1, 1, 1] }),
      },
      [edge("rot", "out", "td", "m"), edge("td", "out", "compose", "position")],
      [bind("particleTransform", "compose", "out"), bind("albedo", "col", "out")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    // particleTransform is a vertex slot, so the rotation and transform land in the vertex body.
    expect(shader.vertex.body.join("\n")).toContain("mat3");
    expect(shader.outputs["particleTransform"]).toBeDefined();
  });

  it("euler-to-rotation builds a mat3 that drives compose-transform -> particleTransform", () => {
    const graph = graphOf(
      {
        euler: reg.create("euler-to-rotation", { angles: [0.3, 0.6, 0.9] }),
        compose: reg.create("compose-transform"),
        col: reg.create("constant", { type: "color", value: [1, 1, 1, 1] }),
      },
      [edge("euler", "out", "compose", "rotation")],
      [bind("particleTransform", "compose", "out"), bind("albedo", "col", "out")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    const vertex = shader.vertex.body.join("\n");
    expect(shader.outputs["particleTransform"]).toBeDefined();
    // The Euler build lands in the vertex stage (feeds a vertex transform slot) with trig.
    expect(vertex).toContain("mat3");
    expect(vertex.toLowerCase()).toContain("cos");
    expect(vertex.toLowerCase()).toContain("sin");
  });

  it("align-to-velocity builds a mat3 that drives compose-transform -> particleTransform", () => {
    const graph = graphOf(
      {
        atv: reg.create("align-to-velocity", { velocity: [1, 0, 0] }),
        compose: reg.create("compose-transform"),
        col: reg.create("constant", { type: "color", value: [1, 1, 1, 1] }),
      },
      [edge("atv", "out", "compose", "rotation")],
      [bind("particleTransform", "compose", "out"), bind("albedo", "col", "out")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    const vertex = shader.vertex.body.join("\n");
    expect(shader.outputs["particleTransform"]).toBeDefined();
    expect(vertex).toContain("mat3");
    expect(vertex.toLowerCase()).toContain("cross");
    // Default (cameraModel: "parallel") reads the shared view-forward, not the per-particle path.
    expect(vertex).toContain("viewMatrix");
  });

  it("align-to-velocity's position input overrides PARTICLE_POSITION for the point camera model", () => {
    const graph = graphOf(
      {
        pos: reg.create("constant", { type: "vec3", value: [5, 0, 0] }),
        atv: reg.create("align-to-velocity", { velocity: [1, 0, 0], cameraModel: "point" }),
        compose: reg.create("compose-transform"),
        col: reg.create("constant", { type: "color", value: [1, 1, 1, 1] }),
      },
      [edge("pos", "out", "atv", "position"), edge("atv", "out", "compose", "rotation")],
      [bind("particleTransform", "compose", "out"), bind("albedo", "col", "out")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    const vertex = shader.vertex.body.join("\n");
    expect(vertex).toContain("cameraPosition");
    // The wired position overrides the default PARTICLE_POSITION read entirely.
    expect(vertex).not.toContain("PARTICLE_POSITION");
  });

  it("align-to-velocity: axis/flip/cameraAxis together still compile to a single mat3", () => {
    const graph = graphOf(
      {
        atv: reg.create("align-to-velocity", {
          velocity: [0, 0, 1],
          axis: "x",
          flip: true,
          cameraAxis: "x", // collides with axis; resolveAlignAxes bumps it to "y".
        }),
        compose: reg.create("compose-transform"),
        col: reg.create("constant", { type: "color", value: [1, 1, 1, 1] }),
      },
      [edge("atv", "out", "compose", "rotation")],
      [bind("particleTransform", "compose", "out"), bind("albedo", "col", "out")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    expect(shader.outputs["particleTransform"]).toBeDefined();
    expect(shader.vertex.body.join("\n")).toContain("mat3");
  });

  describe("resolveAlignAxes", () => {
    it("places the up-reference opposite the up-like slot for each default axis pairing", () => {
      // The reference sits opposite the "up"-like slot, with the matching derivation order.
      expect(resolveAlignAxes("x", "z")).toEqual({
        velocityAxis: "x",
        cameraAxis: "z",
        derivedAxis: "y",
        derivedFromVelocityFirst: false,
      });
      expect(resolveAlignAxes("y", "z")).toEqual({
        velocityAxis: "y",
        cameraAxis: "z",
        derivedAxis: "x",
        derivedFromVelocityFirst: true,
      });
      expect(resolveAlignAxes("z", "y")).toEqual({
        velocityAxis: "z",
        cameraAxis: "y",
        derivedAxis: "x",
        derivedFromVelocityFirst: false,
      });
    });

    it("bumps cameraAxis to the next axis on a collision with axis", () => {
      expect(resolveAlignAxes("x", "x")).toEqual({
        velocityAxis: "x",
        cameraAxis: "y",
        derivedAxis: "z",
        derivedFromVelocityFirst: true,
      });
      expect(resolveAlignAxes("y", "y")).toEqual({
        velocityAxis: "y",
        cameraAxis: "z",
        derivedAxis: "x",
        derivedFromVelocityFirst: true,
      });
      expect(resolveAlignAxes("z", "z")).toEqual({
        velocityAxis: "z",
        cameraAxis: "x",
        derivedAxis: "y",
        derivedFromVelocityFirst: true,
      });
    });

    it("resolves every valid (axis, cameraAxis) pair to a distinct, complete axis triad", () => {
      for (const axis of ["x", "y", "z"]) {
        for (const cameraAxis of ["x", "y", "z"]) {
          const resolved = resolveAlignAxes(axis, cameraAxis);
          const triad = [resolved.velocityAxis, resolved.cameraAxis, resolved.derivedAxis];
          expect(new Set(triad)).toEqual(new Set(["x", "y", "z"]));
          expect(resolved.velocityAxis).toBe(axis);
        }
      }
    });
  });

  it("transform-point transforms a point through a mat4 (translation applied)", () => {
    const graph = graphOf(
      {
        trans: reg.create("translation-matrix", { offset: [1, 2, 3] }),
        tp: reg.create("transform-point", { p: [0, 0, 0] }),
        compose: reg.create("compose-transform"),
        col: reg.create("constant", { type: "color", value: [1, 1, 1, 1] }),
      },
      [edge("trans", "out", "tp", "m"), edge("tp", "out", "compose", "position")],
      [bind("particleTransform", "compose", "out"), bind("albedo", "col", "out")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    expect(shader.vertex.body.join("\n")).toContain("mat4");
    expect(shader.outputs["particleTransform"]).toBeDefined();
  });

  it("normal-matrix emits the inverse and transpose helpers", () => {
    const graph = graphOf(
      {
        trans: reg.create("translation-matrix", { offset: [1, 2, 3] }),
        nm: reg.create("normal-matrix"),
        td: reg.create("transform-direction", { v: [0, 0, 1] }),
        col: reg.create("constant", { type: "color", value: [1, 1, 1, 1] }),
        lit: reg.create("lambert-shading"),
      },
      [
        edge("trans", "out", "nm", "model"),
        edge("nm", "out", "td", "m"),
        edge("col", "out", "lit", "color"),
        edge("td", "out", "lit", "normal"),
      ],
      [bind("albedo", "lit", "color")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    const helpers = shader.fragment.helperFunctions.join("\n");
    expect(helpers).toContain("fxInverse");
    expect(helpers).toContain("fxTranspose");
  });

  it("matrix-multiply composes two mat3 rotations into one applied transform", () => {
    const graph = graphOf(
      {
        a: reg.create("rotation-matrix", { axis: [1, 0, 0], angle: 0.5 }),
        b: reg.create("rotation-matrix", { axis: [0, 1, 0], angle: 0.5 }),
        mul: reg.create("matrix-multiply"),
        td: reg.create("transform-direction", { v: [0, 0, 1] }),
        col: reg.create("constant", { type: "color", value: [1, 1, 1, 1] }),
        lit: reg.create("lambert-shading"),
      },
      [
        edge("a", "out", "mul", "a"),
        edge("b", "out", "mul", "b"),
        edge("mul", "out", "td", "m"),
        edge("col", "out", "lit", "color"),
        edge("td", "out", "lit", "normal"),
      ],
      [bind("albedo", "lit", "color")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    expect(shader.outputs["albedo"]).toBeDefined();
  });

  it("combine-mat3 assembles columns (a wired one + inline ones) into an applied mat3", () => {
    // Column 0 comes from a wired vec3 constant; columns 1/2 from the node's inline pins. The
    // result drives transform-direction into the normal slot, so the whole mat3 prints to GLSL.
    const graph = graphOf(
      {
        c0: reg.create("constant", { type: "vec3", value: [1, 0, 0] }),
        cm: reg.create("combine-mat3", { y: [0, 1, 0], z: [0, 0, 1] }),
        td: reg.create("transform-direction", { v: [1, 2, 3] }),
        col: reg.create("constant", { type: "color", value: [1, 1, 1, 1] }),
        lit: reg.create("lambert-shading"),
      },
      [
        edge("c0", "out", "cm", "x"),
        edge("cm", "out", "td", "m"),
        edge("col", "out", "lit", "color"),
        edge("td", "out", "lit", "normal"),
      ],
      [bind("albedo", "lit", "color")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    expect(shader.fragment.body.join("\n")).toContain("mat3");
    expect(shader.outputs["albedo"]).toBeDefined();
  });

  it("split-mat3 feeds a matrix column into a shading normal", () => {
    const graph = graphOf(
      {
        rot: reg.create("rotation-matrix", { axis: [0, 0, 1], angle: 1 }),
        sm: reg.create("split-mat3"),
        col: reg.create("constant", { type: "color", value: [1, 1, 1, 1] }),
        lit: reg.create("lambert-shading"),
      },
      [
        edge("rot", "out", "sm", "v"),
        edge("col", "out", "lit", "color"),
        edge("sm", "y", "lit", "normal"),
      ],
      [bind("albedo", "lit", "color")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    expect(shader.outputs["albedo"]).toBeDefined();
  });

  it("world-matrix reads Three's modelMatrix (free in the vertex stage, no extra uniform)", () => {
    // world-matrix -> transform-point -> compose-transform -> particleTransform (vertex slot).
    // modelMatrix is Three's built-in vertex uniform, so the vertex body references it and no
    // u_ uniform is added.
    const graph = graphOf(
      {
        wm: reg.create("world-matrix"),
        tp: reg.create("transform-point", { p: [0, 0, 0] }),
        compose: reg.create("compose-transform"),
        col: reg.create("constant", { type: "color", value: [1, 1, 1, 1] }),
      },
      [edge("wm", "out", "tp", "m"), edge("tp", "out", "compose", "position")],
      [bind("particleTransform", "compose", "out"), bind("albedo", "col", "out")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    expect(shader.vertex.body.join("\n")).toContain("modelMatrix");
    // It is a host builtin (like u_time), not a compiler-allocated uniform.
    expect(Object.keys(shader.uniforms)).toHaveLength(0);
  });

  it("matrix-to-mat3 resizes world-matrix down to feed transform-direction (mat3(modelMatrix))", () => {
    const graph = graphOf(
      {
        wm: reg.create("world-matrix"),
        m3: reg.create("matrix-to-mat3"),
        td: reg.create("transform-direction", { v: [0, 0, 1] }),
        col: reg.create("constant", { type: "color", value: [1, 1, 1, 1] }),
        lit: reg.create("lambert-shading"),
      },
      [
        edge("wm", "out", "m3", "m"),
        edge("m3", "out", "td", "m"),
        edge("col", "out", "lit", "color"),
        edge("td", "out", "lit", "normal"),
      ],
      [bind("albedo", "lit", "color")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    const source = shader.fragment.body.join("\n") + shader.vertex.body.join("\n");
    expect(source).toContain("modelMatrix");
    // The resize is GLSL's native mat3(mat4) constructor - a reindex, no arithmetic.
    expect(source).toContain("mat3(");
    expect(shader.outputs["albedo"]).toBeDefined();
  });

  it("inverse-world-matrix derives inverse(modelMatrix) in-shader (emits the inverse helper)", () => {
    const graph = graphOf(
      {
        iwm: reg.create("inverse-world-matrix"),
        tp: reg.create("transform-point", { p: [1, 2, 3] }),
        compose: reg.create("compose-transform"),
        col: reg.create("constant", { type: "color", value: [1, 1, 1, 1] }),
      },
      [edge("iwm", "out", "tp", "m"), edge("tp", "out", "compose", "position")],
      [bind("particleTransform", "compose", "out"), bind("albedo", "col", "out")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    const vsrc = shader.vertex.body.join("\n") + shader.vertex.helperFunctions.join("\n");
    expect(vsrc).toContain("modelMatrix");
    expect(vsrc).toContain("fxInverse");
  });

  it("a matrix produced in vertex crosses into fragment through a mat3 varying", () => {
    // `rot` (turning with the particle's age) feeds a vertex consumer (particleTransform, via
    // compose) AND a fragment one that turns the per-fragment surface normal, so it is placed in
    // the vertex stage and bridged into fragment as a `varying mat3` - matrices ride varyings like
    // any other value (legal GLSL ES 1.00).
    const graph = graphOf(
      {
        age: reg.create("life-ratio"),
        rot: reg.create("rotation-matrix", { axis: [0, 1, 0] }),
        tdV: reg.create("transform-direction", { v: [1, 0, 0] }),
        surface: reg.create("surface-normal"),
        tdF: reg.create("transform-direction"),
        compose: reg.create("compose-transform"),
        col: reg.create("constant", { type: "color", value: [1, 1, 1, 1] }),
        lit: reg.create("lambert-shading"),
      },
      [
        edge("age", "out", "rot", "angle"),
        edge("rot", "out", "tdV", "m"),
        edge("rot", "out", "tdF", "m"),
        edge("surface", "normal", "tdF", "v"),
        edge("tdV", "out", "compose", "position"),
        edge("col", "out", "lit", "color"),
        edge("tdF", "out", "lit", "normal"),
      ],
      [bind("particleTransform", "compose", "out"), bind("albedo", "lit", "color")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    expect(shader.varyings.map((varying) => varying.type.glslTypeName)).toContain("mat3");
  });

  it("a constant matrix is defined in each stage that reads it rather than carried", () => {
    // Read by both stages, but constant: each stage computes it, no varying spent on it.
    const graph = graphOf(
      {
        rot: reg.create("rotation-matrix", { axis: [0, 1, 0], angle: 1 }),
        tdV: reg.create("transform-direction", { v: [1, 0, 0] }),
        tdF: reg.create("transform-direction", { v: [0, 1, 0] }),
        compose: reg.create("compose-transform"),
        col: reg.create("constant", { type: "color", value: [1, 1, 1, 1] }),
        lit: reg.create("lambert-shading"),
      },
      [
        edge("rot", "out", "tdV", "m"),
        edge("rot", "out", "tdF", "m"),
        edge("tdV", "out", "compose", "position"),
        edge("col", "out", "lit", "color"),
        edge("tdF", "out", "lit", "normal"),
      ],
      [bind("particleTransform", "compose", "out"), bind("albedo", "lit", "color")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    expect(shader.varyings).toEqual([]);
    expect(shader.fragment.body.join("\n")).toContain("mat3");
  });
});
