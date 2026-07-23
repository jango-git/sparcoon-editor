import { describe, expect, it } from "vitest";
import { createEmptyGraph, type EditorGraph } from "../../src/domain/graphModel";
import { GraphKind } from "../../src/domain/nodePalette";
import { serializeGraph } from "../../src/domain/serialize";
import { FXGraph } from "../../src/engine/core/FXGraph";
import type { FXGraphSnapshotData } from "../../src/engine/core/live/FXSnapshotData";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import { FX_PARTICLE_TARGET } from "../../src/engine/render/target/FXParticleRenderTarget";
import {
  buildParticleSpawnKernel,
  compileBehavior,
} from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import { buildParticleBehaviorTargets } from "../../src/engine/behavior/FXParticleBehaviorTarget";
import { behaviorRegistry, renderRegistry } from "../helpers/stdRegistry";

// End-to-end proof of the combine/split matrix facades through the WHOLE pipeline: an authored
// editor graph -> serializeGraph (facade expansion) -> reconstruct the engine graph from the
// snapshot exactly as the reconciler does (registry.create per node) -> compile. This closes the
// gap the per-layer unit tests leave (serialize produces the right snapshot; the engine nodes
// compile) by wiring both facades together and compiling the actual serialized artifact.

function makeNode(
  id: string,
  type: string,
  parameters: Record<string, unknown> = {},
): EditorGraph["nodes"][string] {
  return { id, type, parameters, position: { x: 0, y: 0 } };
}

function conn(
  id: string,
  fromNode: string,
  fromKey: string,
  toNode: string,
  toKey: string,
): EditorGraph["connections"][number] {
  return {
    id,
    from: { nodeId: fromNode, socketKey: fromKey },
    to: { nodeId: toNode, socketKey: toKey },
  };
}

function reconstructRender(snapshot: FXGraphSnapshotData): FXGraph<FXRenderNode> {
  const registry = renderRegistry();
  const nodes = new Map<string, FXRenderNode>();
  for (const [id, node] of Object.entries(snapshot.nodes)) {
    nodes.set(id, registry.create(node.type, node.params));
  }
  const graph = new FXGraph<FXRenderNode>();
  graph.ingest({
    nodes,
    connections: snapshot.connections,
    outputBindings: snapshot.outputBindings,
  });
  return graph;
}

function reconstructBehavior(snapshot: FXGraphSnapshotData): FXGraph<FXBehaviorNode> {
  const registry = behaviorRegistry();
  const nodes = new Map<string, FXBehaviorNode>();
  for (const [id, node] of Object.entries(snapshot.nodes)) {
    nodes.set(id, registry.create(node.type, node.params));
  }
  const graph = new FXGraph<FXBehaviorNode>();
  graph.ingest({
    nodes,
    connections: snapshot.connections,
    outputBindings: snapshot.outputBindings,
  });
  return graph;
}

describe("combine/split matrix facades: editor -> serialize -> engine compile", () => {
  it("compiles a render graph where a combine facade feeds a split facade (both expand)", () => {
    const graph: EditorGraph = {
      ...createEmptyGraph(),
      nodes: {
        cm: makeNode("cm", "combine", { type: "mat3" }),
        sp: makeNode("sp", "split"),
        col: makeNode("col", "constant", { type: "vec4", value: [1, 1, 1, 1] }),
        lit: makeNode("lit", "lambert-shading"),
      },
      connections: [
        conn("c", "cm", "out", "sp", "v"),
        conn("c2", "col", "out", "lit", "color"),
        // Split column 0 (a vec3) feeds the lighting node's normal input; a constant supplies the color.
        conn("c3", "sp", "x", "lit", "normal"),
      ],
      outputBindings: [{ slot: "albedo", from: { nodeId: "lit", socketKey: "color" } }],
    };

    const snapshot = serializeGraph(graph, GraphKind.Render);
    expect(snapshot.nodes["cm"].type).toBe("combine-mat3");
    expect(snapshot.nodes["sp"].type).toBe("split-mat3");

    const shader = new FXCompilerBaseline().compile(
      reconstructRender(snapshot),
      FX_PARTICLE_TARGET,
    );
    expect(shader.outputs["albedo"]).toBeDefined();
    // The column extraction printed as native GLSL matrix indexing somewhere in the pipeline.
    const source = shader.vertex.body.join("\n") + shader.fragment.body.join("\n");
    expect(source).toContain(")[");
  });

  it("runs a behavior graph combine(mat3) -> split -> position and gets the right column", () => {
    const graph: EditorGraph = {
      ...createEmptyGraph(),
      nodes: {
        cm: makeNode("cm", "combine", { type: "mat3", x: [1, 2, 3], y: [4, 5, 6], z: [7, 8, 9] }),
        sp: makeNode("sp", "split"),
      },
      connections: [conn("c", "cm", "out", "sp", "v")],
      outputBindings: [
        { slot: "position", from: { nodeId: "sp", socketKey: "y" }, phase: "spawn" },
      ],
    };

    const snapshot = serializeGraph(graph, GraphKind.Behavior);
    expect(snapshot.nodes["cm"].type).toBe("combine-mat3");
    expect(snapshot.nodes["sp"].type).toBe("split-mat3");

    const compiled = compileBehavior(reconstructBehavior(snapshot), buildParticleBehaviorTargets());
    const spawn = buildParticleSpawnKernel(compiled);
    const buffers = { position: new Float32Array(3), lifecycle: new Float32Array(2) };
    spawn(buffers, 0, 1, compiled.spawn.bindings);
    // Column 1 of the assembled mat3 is (4,5,6).
    expect([buffers.position[0], buffers.position[1], buffers.position[2]]).toEqual([4, 5, 6]);
  });
});
