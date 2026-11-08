import { describe, expect, it } from "vitest";
import { meshTransformWarnings } from "../../src/domain/meshDiagnostics";
import { serializeGraph } from "../../src/domain/serialize";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXGraphReconciler } from "../../src/engine/core/live/FXGraphReconciler";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import { registerStandardRenderNodes } from "../../src/engine/nodes-std/index";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { registerManualRenderNodes } from "../../src/engine/render/nodes/FXManualRenderNodes";
import type { EditorGraph } from "../../src/domain/graphModel";
import { createDefaultVfxMesh } from "../../src/model/editorState";

function liveGraph(editorGraph: EditorGraph): FXGraph<FXRenderNode> {
  const registry = new FXNodeRegistry<FXRenderNode>();
  registerStandardRenderNodes(registry);
  registerManualRenderNodes(registry);
  const graph = new FXGraph<FXRenderNode>();
  const result = new FXGraphReconciler(registry).reconcile(graph, serializeGraph(editorGraph));
  expect(result.errors).toEqual([]);
  return graph;
}

/** The default mesh's render graph with its bindings replaced by `bindings`. */
function meshGraph(bindings: EditorGraph["outputBindings"]): EditorGraph {
  const graph = createDefaultVfxMesh("mesh_1", "Mesh").renderGraph;
  return { ...graph, outputBindings: bindings };
}

const ALBEDO = { slot: "albedo", from: { nodeId: "n_albedo", socketKey: "out" } };
const codes = (graph: EditorGraph): readonly string[] =>
  meshTransformWarnings(liveGraph(graph)).map((warning) => warning.code);

describe("meshTransformWarnings", () => {
  it("is quiet for the default mesh, which follows its world matrix", () => {
    expect(codes(createDefaultVfxMesh("mesh_1", "Mesh").renderGraph)).toEqual([]);
  });

  it("counts the world matrix through either transform output", () => {
    const world = { nodeId: "n_world", socketKey: "out" };
    expect(codes(meshGraph([ALBEDO, { slot: "particleTransform", from: world }]))).toEqual([]);
  });

  it("warns when no transform output reads the world matrix, though the node is there", () => {
    expect(codes(meshGraph([ALBEDO]))).toEqual(["mesh-ignores-transform"]);
  });
});
