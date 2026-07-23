import { describe, expect, it } from "vitest";
import type { FXConnection, FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import { registerStandardRenderNodes } from "../../src/engine/nodes-std/index";
import { FX_RENDER_TRANSFORM_NODES } from "../../src/engine/nodes-std/render/transform";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import { FX_PARTICLE_TARGET } from "../../src/engine/render/target/FXParticleRenderTarget";

// The transform nodes produce the two mat4 render slots. A billboard is `look-at-camera`
// feeding `particleTransform` (directly or through `compose-transform`), so these graphs
// prove the camera-facing rotation and the PRS compose land in the vertex program.

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

describe("standard render transform nodes", () => {
  const compiler = new FXCompilerBaseline();

  it("registers both definitions and describes serializably", () => {
    const r = registry();
    for (const def of FX_RENDER_TRANSFORM_NODES) {
      expect(r.has(def.type)).toBe(true);
      expect(() => JSON.stringify(def.describe())).not.toThrow();
    }
  });

  it("look-at-camera -> compose-transform drives a camera-facing particleTransform (vertex)", () => {
    const r = registry();
    const graph = graphOf(
      new Map([
        ["look", r.create("look-at-camera", { roll: 0 })],
        ["compose", r.create("compose-transform", { position: [0, 0, 0], scale: [2, 2, 1] })],
        ["col", r.create("constant", { type: "color", value: [1, 1, 1, 1] })],
      ]),
      [edge("look", "out", "compose", "rotation")],
      [bind("particleTransform", "compose", "out"), bind("albedo", "col", "out")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    const vertex = shader.vertex.body.join("\n");
    // The whole chain lands in the vertex stage (particleTransform is a vertex slot).
    expect(shader.outputs["particleTransform"]).toBeDefined();
    expect(vertex).toContain("mat4");
    // look-at-camera reads the view matrix and transposes its rotation to build the basis.
    expect(vertex).toContain("viewMatrix");
    expect(vertex.toLowerCase()).toContain("transpose");
  });

  it("compose-transform with an unwired rotation still compiles (identity default)", () => {
    const r = registry();
    const graph = graphOf(
      new Map([
        ["compose", r.create("compose-transform", { position: [1, 0, 0], scale: [1, 1, 1] })],
        ["col", r.create("constant", { type: "color", value: [1, 1, 1, 1] })],
      ]),
      [],
      [bind("vertexTransform", "compose", "out"), bind("albedo", "col", "out")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    expect(shader.outputs["vertexTransform"]).toBeDefined();
  });

  it.each(["x", "y", "z"] as const)(
    "look-at-camera locked to axis %s compiles a cylindrical (cross-product) basis",
    (axis) => {
      const r = registry();
      const graph = graphOf(
        new Map([
          ["look", r.create("look-at-camera", { roll: 0, axis })],
          ["compose", r.create("compose-transform", { position: [0, 0, 0], scale: [1, 1, 1] })],
          ["col", r.create("constant", { type: "color", value: [1, 1, 1, 1] })],
        ]),
        [edge("look", "out", "compose", "rotation")],
        [bind("particleTransform", "compose", "out"), bind("albedo", "col", "out")],
      );
      const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
      const vertex = shader.vertex.body.join("\n").toLowerCase();
      expect(vertex).toContain("cross");
      expect(vertex).toContain("normalize");
    },
  );

  it("look-at-camera locked to an axis with cameraModel: point reads PARTICLE_POSITION/cameraPosition instead of viewMatrix", () => {
    const r = registry();
    const graph = graphOf(
      new Map([
        ["look", r.create("look-at-camera", { roll: 0, axis: "y", cameraModel: "point" })],
        ["compose", r.create("compose-transform", { position: [0, 0, 0], scale: [1, 1, 1] })],
        ["col", r.create("constant", { type: "color", value: [1, 1, 1, 1] })],
      ]),
      [edge("look", "out", "compose", "rotation")],
      [bind("particleTransform", "compose", "out"), bind("albedo", "col", "out")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    const vertex = shader.vertex.body.join("\n");
    expect(vertex).toContain("cameraPosition");
    expect(vertex).toContain("PARTICLE_POSITION");
    // Particle position is already world space by convention - no modelMatrix conversion.
    expect(vertex).not.toContain("modelMatrix");
    expect(vertex).not.toContain("viewMatrix");
  });

  it('look-at-camera axis "all" ignores cameraModel (no fixed axis to build a per-particle direction against)', () => {
    const r = registry();
    const graph = graphOf(
      new Map([
        ["look", r.create("look-at-camera", { roll: 0, cameraModel: "point" })],
        ["compose", r.create("compose-transform", { position: [0, 0, 0], scale: [1, 1, 1] })],
        ["col", r.create("constant", { type: "color", value: [1, 1, 1, 1] })],
      ]),
      [edge("look", "out", "compose", "rotation")],
      [bind("particleTransform", "compose", "out"), bind("albedo", "col", "out")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    const vertex = shader.vertex.body.join("\n");
    expect(vertex).toContain("viewMatrix");
    expect(vertex).not.toContain("cameraPosition");
  });

  it('look-at-camera defaults to axis "all" (the unconstrained billboard, no cross product)', () => {
    const r = registry();
    const graph = graphOf(
      new Map([
        ["look", r.create("look-at-camera", { roll: 0 })],
        ["compose", r.create("compose-transform", { position: [0, 0, 0], scale: [1, 1, 1] })],
        ["col", r.create("constant", { type: "color", value: [1, 1, 1, 1] })],
      ]),
      [edge("look", "out", "compose", "rotation")],
      [bind("particleTransform", "compose", "out"), bind("albedo", "col", "out")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    const vertex = shader.vertex.body.join("\n").toLowerCase();
    expect(vertex).not.toContain("cross");
  });

  it("rejects look-at-camera driving a fragment slot (viewMatrix is vertex-only)", () => {
    const r = registry();
    // Feed look-at's mat3 nowhere legal in fragment: bind albedo requires vec4, but we can at
    // least assert viewMatrix stays out of the fragment program in the valid case above.
    // Here we simply ensure the node cannot be read as albedo (type mismatch guards it).
    const graph = graphOf(
      new Map([["look", r.create("look-at-camera", { roll: 0 })]]),
      [],
      [bind("albedo", "look", "out")],
    );
    expect(() => compiler.compile(graph, FX_PARTICLE_TARGET)).toThrow();
  });
});
