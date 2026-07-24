import { describe, expect, it } from "vitest";
import { FXGraph } from "../../src/engine/core/FXGraph";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FXRenderNodeCustomAttribute } from "../../src/engine/render/nodes/FXRenderNodeCustomAttribute";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { FX_MESH_TARGET } from "../../src/engine/render/target/FXParticleRenderTarget";
import {
  compileMeshArtifact,
  validateMeshArtifact,
} from "../../src/engine/emit/compileMeshArtifact";
import { renderRegistry } from "../helpers/stdRegistry";

const VEC4 = FX_VALUE_TYPES.vec4;

const reg = renderRegistry();

/** A minimal mesh-legal render graph: a constant color drives albedo. */
function constantAlbedo(): FXGraph<FXRenderNode> {
  const graph = new FXGraph<FXRenderNode>();
  graph.ingest({
    nodes: new Map<string, FXRenderNode>([
      ["col", reg.create("constant", { type: "color", value: [0.2, 0.4, 0.8, 1] })],
    ]),
    connections: [],
    outputBindings: [{ slot: "albedo", from: { nodeId: "col", socketKey: "out" } }],
  });
  return graph;
}

/** `look-at-camera -> compose-transform -> vertexTransform` (reads viewMatrix, a mesh builtin). The
 *  mesh's local-space deform slot; `particleTransform` is particle-only and not bindable here. */
function vertexTransformOnMesh(): FXGraph<FXRenderNode> {
  const graph = new FXGraph<FXRenderNode>();
  graph.ingest({
    nodes: new Map<string, FXRenderNode>([
      ["col", reg.create("constant", { type: "color", value: [1, 1, 1, 1] })],
      ["look", reg.create("look-at-camera", { roll: 0 })],
      ["compose", reg.create("compose-transform", {})],
    ]),
    connections: [
      {
        from: { nodeId: "look", socketKey: "out" },
        to: { nodeId: "compose", socketKey: "rotation" },
      },
    ],
    outputBindings: [
      { slot: "albedo", from: { nodeId: "col", socketKey: "out" } },
      { slot: "vertexTransform", from: { nodeId: "compose", socketKey: "out" } },
    ],
  });
  return graph;
}

/** Binds `particleTransform` - a particle-only surface slot the mesh target omits (now illegal). */
function particleTransformOnMesh(): FXGraph<FXRenderNode> {
  const graph = new FXGraph<FXRenderNode>();
  graph.ingest({
    nodes: new Map<string, FXRenderNode>([
      ["col", reg.create("constant", { type: "color", value: [1, 1, 1, 1] })],
      ["compose", reg.create("compose-transform", {})],
    ]),
    connections: [],
    outputBindings: [
      { slot: "albedo", from: { nodeId: "col", socketKey: "out" } },
      { slot: "particleTransform", from: { nodeId: "compose", socketKey: "out" } },
    ],
  });
  return graph;
}

/** A render graph reading a per-particle user attribute (illegal on a mesh - no attributes). */
function attributeAlbedo(): FXGraph<FXRenderNode> {
  const graph = new FXGraph<FXRenderNode>();
  graph.ingest({
    nodes: new Map<string, FXRenderNode>([["tint", new FXRenderNodeCustomAttribute("tint", VEC4)]]),
    connections: [],
    outputBindings: [{ slot: "albedo", from: { nodeId: "tint", socketKey: "value" } }],
  });
  return graph;
}

/** A render graph reading a particle builtin (life-ratio needs PARTICLE_AGE/LIFETIME). */
function lifeRatioAlbedo(): FXGraph<FXRenderNode> {
  const graph = new FXGraph<FXRenderNode>();
  graph.ingest({
    nodes: new Map<string, FXRenderNode>([
      ["life", reg.create("life-ratio", {})],
      ["col", reg.create("constant", { type: "color", value: [1, 1, 1, 1] })],
    ]),
    connections: [
      { from: { nodeId: "life", socketKey: "ratio" }, to: { nodeId: "col", socketKey: "value" } },
    ],
    outputBindings: [{ slot: "albedo", from: { nodeId: "col", socketKey: "out" } }],
  });
  return graph;
}

describe("FX_MESH_TARGET shape", () => {
  const names = new Set(FX_MESH_TARGET.inputs.map((input) => input.name));

  it("exposes the geometry/frame/camera builtins a mesh can supply", () => {
    for (const name of [
      "p_uv",
      "geometryNormal",
      "geometryTangent",
      "worldPosition",
      "u_time",
      "u_deltaTime",
      "modelMatrix",
      "viewMatrix",
      "cameraPosition",
    ]) {
      expect(names.has(name)).toBe(true);
    }
  });

  it("omits every per-particle builtin", () => {
    for (const name of [
      "PARTICLE_POSITION",
      "PARTICLE_POSITION_X",
      "PARTICLE_AGE",
      "PARTICLE_LIFETIME",
      "p_cameraDistance",
    ]) {
      expect(names.has(name)).toBe(false);
    }
  });

  it("keeps the shared surface slots but omits the particle-only particleTransform", () => {
    const slots = new Set(FX_MESH_TARGET.outputs.map((output) => output.slot));
    expect(slots.has("albedo")).toBe(true);
    expect(slots.has("vertexTransform")).toBe(true);
    expect(slots.has("additivity")).toBe(true);
    expect(slots.has("alphaThreshold")).toBe(true);
    expect(slots.has("particleTransform")).toBe(false);
  });
});

describe("compileMeshArtifact (render-only, attribute-free)", () => {
  it("compiles a constant-albedo graph with no attribute reads", () => {
    const { render, hash } = compileMeshArtifact(constantAlbedo());
    expect(render.outputs["albedo"]).toBeDefined();
    expect(render.attributeReads).toEqual([]);
    expect(render.geometry).toEqual({ type: "primitive", primitive: "plane" });
    expect(hash).toContain('geo-{"type":"primitive","primitive":"plane"}');
  });

  it("compiles a mesh-legal vertex transform reading viewMatrix", () => {
    const { render } = compileMeshArtifact(vertexTransformOnMesh(), {
      geometry: { type: "primitive", primitive: "box" },
    });
    expect(render.outputs["vertexTransform"]).toBeDefined();
    expect(render.geometry).toEqual({ type: "primitive", primitive: "box" });
  });

  it("is stable: same graph => same hash", () => {
    expect(compileMeshArtifact(constantAlbedo()).hash).toBe(
      compileMeshArtifact(constantAlbedo()).hash,
    );
  });
});

describe("validateMeshArtifact rejects particle-only nodes", () => {
  it("rejects reading a per-particle user attribute", () => {
    expect(validateMeshArtifact(attributeAlbedo()).length).toBeGreaterThan(0);
    expect(() => compileMeshArtifact(attributeAlbedo())).toThrow();
  });

  it("rejects a life-ratio node (reads PARTICLE_AGE/LIFETIME)", () => {
    expect(validateMeshArtifact(lifeRatioAlbedo()).length).toBeGreaterThan(0);
  });

  it("rejects binding the particle-only particleTransform slot", () => {
    expect(validateMeshArtifact(particleTransformOnMesh()).length).toBeGreaterThan(0);
    expect(() => compileMeshArtifact(particleTransformOnMesh())).toThrow();
  });

  it("accepts a mesh-legal graph (no errors)", () => {
    expect(validateMeshArtifact(constantAlbedo())).toEqual([]);
    expect(validateMeshArtifact(vertexTransformOnMesh())).toEqual([]);
  });
});
