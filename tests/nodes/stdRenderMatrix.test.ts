import { describe, expect, it } from "vitest";
import type { FXConnection, FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import {
  registerStandardBehaviorNodes,
  registerStandardRenderNodes,
} from "../../src/engine/nodes-std/index";
import { FX_RENDER_MATRIX_NODES, resolveAlignAxes } from "../../src/engine/nodes-std/render/matrix";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import { FX_PARTICLE_TARGET } from "../../src/engine/render/target/FXParticleRenderTarget";

// Matrix nodes are render-only (domain: "render"); they build/compose/apply mat2/mat3/mat4
// transforms in the shader. These graphs are hand-built (the generic contract harness cannot
// synthesize matrix inputs from a `constant`), binding a matrix-derived vec3/vec4 to a real
// output slot so the whole chain compiles to GLSL.

function bind(slot: string, nodeId: string, socketKey: string): FXOutputBinding {
  return { slot, from: { nodeId, socketKey } };
}
function edge(fromNode: string, fromKey: string, toNode: string, toKey: string): FXConnection {
  return {
    from: { nodeId: fromNode, socketKey: fromKey },
    to: { nodeId: toNode, socketKey: toKey },
  };
}
function registry(): FXNodeRegistry<FXRenderNode> {
  const r = new FXNodeRegistry<FXRenderNode>();
  registerStandardRenderNodes(r);
  return r;
}
function graphOf(
  nodes: Map<string, FXRenderNode>,
  connections: readonly FXConnection[],
  out: readonly FXOutputBinding[],
): FXGraph<FXRenderNode> {
  const graph = new FXGraph<FXRenderNode>();
  graph.ingest({ nodes, connections, outputBindings: out });
  return graph;
}

describe("standard render matrix nodes", () => {
  const compiler = new FXCompilerBaseline();

  it("registers every matrix definition and describes serializably", () => {
    const r = registry();
    for (const def of FX_RENDER_MATRIX_NODES) {
      expect(r.has(def.type)).toBe(true);
      expect(() => JSON.stringify(def.describe())).not.toThrow();
    }
  });

  it("matrix nodes are shared except the render-only view-matrix nodes", () => {
    const behaviorReg = new FXNodeRegistry<FXBehaviorNode>();
    registerStandardBehaviorNodes(behaviorReg);
    const renderReg = registry();
    // The behavior target has no camera, so view-matrix / inverse-view-matrix / align-to-velocity
    // (it now also faces a camera axis) are render-only.
    const renderOnly = new Set(["view-matrix", "inverse-view-matrix", "align-to-velocity"]);
    for (const def of FX_RENDER_MATRIX_NODES) {
      expect(renderReg.has(def.type)).toBe(true);
      // world-matrix reads `modelMatrix` on both sides; the shared ones live in both registries.
      expect(behaviorReg.has(def.type)).toBe(!renderOnly.has(def.type));
    }
  });

  it("rotation-matrix drives transform-direction into a vertex slot (mat3 in the vertex stage)", () => {
    const r = registry();
    const graph = graphOf(
      new Map([
        ["rot", r.create("rotation-matrix", { axis: [0, 1, 0], angle: 1 })],
        ["td", r.create("transform-direction", { v: [1, 0, 0] })],
        ["compose", r.create("compose-transform", {})],
        ["col", r.create("constant", { type: "color", value: [1, 1, 1, 1] })],
      ]),
      [edge("rot", "out", "td", "m"), edge("td", "out", "compose", "position")],
      [bind("particleTransform", "compose", "out"), bind("albedo", "col", "out")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    // particleTransform is a vertex slot, so the rotation and transform land in the vertex body.
    expect(shader.vertex.body.join("\n")).toContain("mat3");
    expect(shader.outputs["particleTransform"]).toBeDefined();
  });

  it("euler-to-rotation builds a mat3 that drives compose-transform -> particleTransform", () => {
    const r = registry();
    const graph = graphOf(
      new Map([
        ["euler", r.create("euler-to-rotation", { angles: [0.3, 0.6, 0.9] })],
        ["compose", r.create("compose-transform", {})],
        ["col", r.create("constant", { type: "color", value: [1, 1, 1, 1] })],
      ]),
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
    const r = registry();
    const graph = graphOf(
      new Map([
        ["atv", r.create("align-to-velocity", { velocity: [1, 0, 0] })],
        ["compose", r.create("compose-transform", {})],
        ["col", r.create("constant", { type: "color", value: [1, 1, 1, 1] })],
      ]),
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

  it("align-to-velocity with cameraModel: point reads PARTICLE_POSITION/cameraPosition instead of viewMatrix", () => {
    const r = registry();
    const graph = graphOf(
      new Map([
        ["atv", r.create("align-to-velocity", { velocity: [1, 0, 0], cameraModel: "point" })],
        ["compose", r.create("compose-transform", {})],
        ["col", r.create("constant", { type: "color", value: [1, 1, 1, 1] })],
      ]),
      [edge("atv", "out", "compose", "rotation")],
      [bind("particleTransform", "compose", "out"), bind("albedo", "col", "out")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    const vertex = shader.vertex.body.join("\n");
    expect(shader.outputs["particleTransform"]).toBeDefined();
    expect(vertex).toContain("cameraPosition");
    expect(vertex).toContain("PARTICLE_POSITION");
    // Particle position is already world space by convention - no modelMatrix conversion.
    expect(vertex).not.toContain("modelMatrix");
    expect(vertex).not.toContain("viewMatrix");
  });

  it("align-to-velocity's position input overrides PARTICLE_POSITION for the point camera model", () => {
    const r = registry();
    const graph = graphOf(
      new Map([
        ["pos", r.create("constant", { type: "vec3", value: [5, 0, 0] })],
        ["atv", r.create("align-to-velocity", { velocity: [1, 0, 0], cameraModel: "point" })],
        ["compose", r.create("compose-transform", {})],
        ["col", r.create("constant", { type: "color", value: [1, 1, 1, 1] })],
      ]),
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
    const r = registry();
    const graph = graphOf(
      new Map([
        [
          "atv",
          r.create("align-to-velocity", {
            velocity: [0, 0, 1],
            axis: "x",
            flip: true,
            cameraAxis: "x", // collides with axis; resolveAlignAxes bumps it to "y".
          }),
        ],
        ["compose", r.create("compose-transform", {})],
        ["col", r.create("constant", { type: "color", value: [1, 1, 1, 1] })],
      ]),
      [edge("atv", "out", "compose", "rotation")],
      [bind("particleTransform", "compose", "out"), bind("albedo", "col", "out")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    expect(shader.outputs["particleTransform"]).toBeDefined();
    expect(shader.vertex.body.join("\n")).toContain("mat3");
  });

  describe("resolveAlignAxes", () => {
    it("keeps the old fixed up-reference placement for each axis (regression: matches prior fixed-mapping build)", () => {
      // These are the three cases the node previously hardcoded (reference always opposite the
      // "up"-like slot); resolveAlignAxes must reproduce the same placement/sign for them.
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
    const r = registry();
    const graph = graphOf(
      new Map([
        ["trans", r.create("translation-matrix", { offset: [1, 2, 3] })],
        ["tp", r.create("transform-point", { p: [0, 0, 0] })],
        ["compose", r.create("compose-transform", {})],
        ["col", r.create("constant", { type: "color", value: [1, 1, 1, 1] })],
      ]),
      [edge("trans", "out", "tp", "m"), edge("tp", "out", "compose", "position")],
      [bind("particleTransform", "compose", "out"), bind("albedo", "col", "out")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    expect(shader.vertex.body.join("\n")).toContain("mat4");
    expect(shader.outputs["particleTransform"]).toBeDefined();
  });

  it("normal-matrix emits the inverse and transpose helpers", () => {
    const r = registry();
    const graph = graphOf(
      new Map([
        ["trans", r.create("translation-matrix", { offset: [1, 2, 3] })],
        ["nm", r.create("normal-matrix", {})],
        ["td", r.create("transform-direction", { v: [0, 0, 1] })],
        ["col", r.create("constant", { type: "color", value: [1, 1, 1, 1] })],
        ["lit", r.create("lambert-shading", {})],
      ]),
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
    const r = registry();
    const graph = graphOf(
      new Map([
        ["a", r.create("rotation-matrix", { axis: [1, 0, 0], angle: 0.5 })],
        ["b", r.create("rotation-matrix", { axis: [0, 1, 0], angle: 0.5 })],
        ["mul", r.create("matrix-multiply", {})],
        ["td", r.create("transform-direction", { v: [0, 0, 1] })],
        ["col", r.create("constant", { type: "color", value: [1, 1, 1, 1] })],
        ["lit", r.create("lambert-shading", {})],
      ]),
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
    const r = registry();
    // Column 0 comes from a wired vec3 constant; columns 1/2 from the node's inline pins. The
    // result drives transform-direction into the normal slot, so the whole mat3 prints to GLSL.
    const graph = graphOf(
      new Map([
        ["c0", r.create("constant", { type: "vec3", value: [1, 0, 0] })],
        ["cm", r.create("combine-mat3", { y: [0, 1, 0], z: [0, 0, 1] })],
        ["td", r.create("transform-direction", { v: [1, 2, 3] })],
        ["col", r.create("constant", { type: "color", value: [1, 1, 1, 1] })],
        ["lit", r.create("lambert-shading", {})],
      ]),
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

  it("split-mat3 extracts a column via native GLSL matrix indexing ((m)[i])", () => {
    const r = registry();
    const graph = graphOf(
      new Map([
        ["rot", r.create("rotation-matrix", { axis: [0, 0, 1], angle: 1 })],
        ["sm", r.create("split-mat3", {})],
        ["col", r.create("constant", { type: "color", value: [1, 1, 1, 1] })],
        ["lit", r.create("lambert-shading", {})],
      ]),
      [
        edge("rot", "out", "sm", "v"),
        edge("col", "out", "lit", "color"),
        edge("sm", "y", "lit", "normal"),
      ],
      [bind("albedo", "lit", "color")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    const source = shader.fragment.body.join("\n") + shader.vertex.body.join("\n");
    expect(source).toContain(")["); // column access prints as `(m)[i]`
    expect(shader.outputs["albedo"]).toBeDefined();
  });

  it("world-matrix reads Three's modelMatrix (free in the vertex stage, no extra uniform)", () => {
    const r = registry();
    // world-matrix -> transform-point -> compose-transform -> particleTransform (vertex slot).
    // modelMatrix is Three's built-in vertex uniform, so the vertex body references it and no
    // u_ uniform is added.
    const graph = graphOf(
      new Map([
        ["wm", r.create("world-matrix", {})],
        ["tp", r.create("transform-point", { p: [0, 0, 0] })],
        ["compose", r.create("compose-transform", {})],
        ["col", r.create("constant", { type: "color", value: [1, 1, 1, 1] })],
      ]),
      [edge("wm", "out", "tp", "m"), edge("tp", "out", "compose", "position")],
      [bind("particleTransform", "compose", "out"), bind("albedo", "col", "out")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    expect(shader.vertex.body.join("\n")).toContain("modelMatrix");
    // It is a host builtin (like u_time), not a compiler-allocated uniform.
    expect(Object.keys(shader.uniforms)).toHaveLength(0);
  });

  it("matrix-to-mat3 resizes world-matrix down to feed transform-direction (mat3(modelMatrix))", () => {
    const r = registry();
    const graph = graphOf(
      new Map([
        ["wm", r.create("world-matrix", {})],
        ["m3", r.create("matrix-to-mat3", {})],
        ["td", r.create("transform-direction", { v: [0, 0, 1] })],
        ["col", r.create("constant", { type: "color", value: [1, 1, 1, 1] })],
        ["lit", r.create("lambert-shading", {})],
      ]),
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
    // The resize prints as GLSL's native mat3(matN) constructor - a reindex, no arithmetic.
    expect(source).toMatch(/mat3 matrix_to_mat3_out_\d+ = mat3\(/);
    expect(shader.outputs["albedo"]).toBeDefined();
  });

  it("inverse-world-matrix derives inverse(modelMatrix) in-shader (emits the inverse helper)", () => {
    const r = registry();
    const graph = graphOf(
      new Map([
        ["iwm", r.create("inverse-world-matrix", {})],
        ["tp", r.create("transform-point", { p: [1, 2, 3] })],
        ["compose", r.create("compose-transform", {})],
        ["col", r.create("constant", { type: "color", value: [1, 1, 1, 1] })],
      ]),
      [edge("iwm", "out", "tp", "m"), edge("tp", "out", "compose", "position")],
      [bind("particleTransform", "compose", "out"), bind("albedo", "col", "out")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    const vsrc = shader.vertex.body.join("\n") + shader.vertex.helperFunctions.join("\n");
    expect(vsrc).toContain("modelMatrix");
    expect(vsrc).toContain("fxInverse");
  });

  it("a matrix produced in vertex crosses into fragment through a mat3 varying", () => {
    const r = registry();
    // `rot` feeds a vertex consumer (particleTransform, via compose) AND a fragment consumer
    // (normal), so it is placed in the vertex stage and bridged into fragment as a `varying mat3`
    // - matrices ride varyings like any other value (legal GLSL ES 1.00).
    const graph = graphOf(
      new Map([
        ["rot", r.create("rotation-matrix", { axis: [0, 1, 0], angle: 1 })],
        ["tdV", r.create("transform-direction", { v: [1, 0, 0] })],
        ["tdF", r.create("transform-direction", { v: [0, 1, 0] })],
        ["compose", r.create("compose-transform", {})],
        ["col", r.create("constant", { type: "color", value: [1, 1, 1, 1] })],
        ["lit", r.create("lambert-shading", {})],
      ]),
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
    expect(shader.vertex.varyingDeclarations.join("\n")).toContain("varying mat3");
  });
});
