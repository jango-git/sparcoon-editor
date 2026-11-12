import { describe, expect, it } from "vitest";

import { createEmptyGraph, type EditorGraph } from "../../src/domain/graphModel";
import { GraphKind } from "../../src/domain/nodePalette";
import { serializeGraph } from "../../src/domain/serialize";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { compileBehavior } from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import { buildParticleBehaviorTargets } from "../../src/engine/behavior/FXParticleBehaviorTarget";
import { FXGraph } from "../../src/engine/core/FXGraph";
import type { FXGraphSnapshotData } from "../../src/engine/core/live/FXSnapshotData";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FX_PARTICLE_TARGET } from "../../src/engine/render/target/FXParticleRenderTarget";
import { fieldSpawnKernel } from "../helpers/graphBuild";
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

    const shader = new FXCompilerBaseline().compile(
      reconstructRender(serializeGraph(graph, GraphKind.Render)),
      FX_PARTICLE_TARGET,
    );
    expect(shader.outputs["albedo"]).toBeDefined();
    // The combine assembles a native mat3, the split reads its column 0 by GLSL matrix indexing,
    // and that column is the normal the lighting node shades with.
    const source = [...shader.vertex.body, ...shader.fragment.body].join("\n");
    const matrix = /\bmat3 (\w+) = mat3\(/.exec(source)?.[1];
    expect(matrix).toBeDefined();
    const column = new RegExp(`\\bvec3 (\\w+) = \\(${matrix}\\)\\[0\\];`).exec(source)?.[1];
    expect(column).toBeDefined();
    expect(source).toMatch(new RegExp(`\\bfxLambertShade\\(\\w+, ${column}\\)`));
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

    const compiled = compileBehavior(
      reconstructBehavior(serializeGraph(graph, GraphKind.Behavior)),
      buildParticleBehaviorTargets(),
    );
    const spawn = fieldSpawnKernel(compiled);
    const buffers = { position: new Float32Array(3), lifecycle: new Float32Array(2) };
    spawn(buffers, 0, 1, compiled.spawn!.bindings);
    // Column 1 of the assembled mat3 is (4,5,6).
    expect([buffers.position[0], buffers.position[1], buffers.position[2]]).toEqual([4, 5, 6]);
  });
});
