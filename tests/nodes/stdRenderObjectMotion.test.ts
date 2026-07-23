import { describe, expect, it } from "vitest";
import type { FXConnection, FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import { registerStandardRenderNodes } from "../../src/engine/nodes-std/index";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import {
  FX_MESH_TARGET,
  FX_PARTICLE_TARGET,
} from "../../src/engine/render/target/FXParticleRenderTarget";

// `object-velocity` / `object-angular-velocity` are shared nodes: in render they read the
// `objectVelocity`/`objectAngularVelocity` builtins - host state FXEmitter/FXEffect push each
// tick, not a compiler-allocated uniform (same footing as `modelMatrix`, see
// stdRenderMatrix.test.ts's world-matrix test). Legal against both render targets: FXEmitter
// pushes its own object motion for particle rendering exactly as FXEffect does for a VFX mesh.

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

/** `nodeType` (a vec3 source) -> split -> combine(vec4) -> albedo, so it compiles standalone. */
function graphReadingIntoAlbedo(nodeType: string): FXGraph<FXRenderNode> {
  const r = registry();
  const graph = new FXGraph<FXRenderNode>();
  graph.ingest({
    nodes: new Map([
      ["source", r.create(nodeType, {})],
      ["split", r.create("split", {})],
      ["combine", r.create("combine", { type: "vec4" })],
    ]),
    connections: [
      edge("source", "out", "split", "v"),
      edge("split", "x", "combine", "x"),
      edge("split", "y", "combine", "y"),
      edge("split", "z", "combine", "z"),
    ],
    outputBindings: [bind("albedo", "combine", "out")],
  });
  return graph;
}

describe("render object-velocity / object-angular-velocity nodes", () => {
  const compiler = new FXCompilerBaseline();

  it("object-velocity reads the objectVelocity builtin against FX_MESH_TARGET, no compiler-allocated uniform", () => {
    const shader = compiler.compile(graphReadingIntoAlbedo("object-velocity"), FX_MESH_TARGET);
    const source = shader.fragment.body.join("\n") + shader.vertex.body.join("\n");
    expect(source).toContain("objectVelocity");
    expect(Object.keys(shader.uniforms)).toHaveLength(0);
  });

  it("object-angular-velocity reads the objectAngularVelocity builtin against FX_MESH_TARGET", () => {
    const shader = compiler.compile(
      graphReadingIntoAlbedo("object-angular-velocity"),
      FX_MESH_TARGET,
    );
    const source = shader.fragment.body.join("\n") + shader.vertex.body.join("\n");
    expect(source).toContain("objectAngularVelocity");
  });

  it("object-velocity reads the objectVelocity builtin against FX_PARTICLE_TARGET too", () => {
    const shader = compiler.compile(graphReadingIntoAlbedo("object-velocity"), FX_PARTICLE_TARGET);
    const source = shader.fragment.body.join("\n") + shader.vertex.body.join("\n");
    expect(source).toContain("objectVelocity");
    expect(Object.keys(shader.uniforms)).toHaveLength(0);
  });

  it("object-angular-velocity reads the objectAngularVelocity builtin against FX_PARTICLE_TARGET too", () => {
    const shader = compiler.compile(
      graphReadingIntoAlbedo("object-angular-velocity"),
      FX_PARTICLE_TARGET,
    );
    const source = shader.fragment.body.join("\n") + shader.vertex.body.join("\n");
    expect(source).toContain("objectAngularVelocity");
  });
});

describe("render point-velocity node", () => {
  const compiler = new FXCompilerBaseline();

  it("compiles against FX_MESH_TARGET and emits a cross() combining both builtins", () => {
    const shader = compiler.compile(graphReadingIntoAlbedo("point-velocity"), FX_MESH_TARGET);
    const source = shader.fragment.body.join("\n") + shader.vertex.body.join("\n");
    expect(source).toContain("cross(");
    expect(source).toContain("objectVelocity");
    expect(source).toContain("objectAngularVelocity");
    expect(Object.keys(shader.uniforms)).toHaveLength(0);
  });

  it("compiles against FX_PARTICLE_TARGET too, even with velocity/torque fully wired explicitly", () => {
    // Legality is derived from the node's declared socket defaults (its schema), not from
    // whether a given instance actually connects them - so wiring both away from their
    // objectVelocity/objectAngularVelocity defaults does not change the outcome.
    const r = registry();
    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes: new Map([
        ["velocity", r.create("constant", { type: "vec3", value: [1, 0, 0] })],
        ["torque", r.create("constant", { type: "vec3", value: [0, 0, 1] })],
        ["pv", r.create("point-velocity", { offset: [0, 1, 0] })],
        ["split", r.create("split", {})],
        ["combine", r.create("combine", { type: "vec4" })],
      ]),
      connections: [
        edge("velocity", "out", "pv", "velocity"),
        edge("torque", "out", "pv", "torque"),
        edge("pv", "out", "split", "v"),
        edge("split", "x", "combine", "x"),
        edge("split", "y", "combine", "y"),
        edge("split", "z", "combine", "z"),
      ],
      outputBindings: [bind("albedo", "combine", "out")],
    });
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    const source = shader.fragment.body.join("\n") + shader.vertex.body.join("\n");
    expect(source).toContain("cross(");
  });
});
