import type { FXRenderArtifact } from "sparcoon";
import type { FXGraph } from "../FXGraph";
import type { FXGraphNode } from "../FXGraphNode";
import { collectReachableNodeIds } from "./FXGraphTraversal.Internal";

/** What a render graph asks of the runtime beyond its own code - the runtime-defined `fx_` ABI
 *  functions its nodes call, as the render artifact carries them. */
export type FXRenderCapabilities = Pick<FXRenderArtifact, "lightingIntrinsics" | "sceneDepth">;

/**
 * The capabilities of a render graph's **reachable** nodes: the union of their lighting
 * intrinsics ({@link FXGraphNode.lightingIntrinsic}; empty => unlit, non-empty => the runtime
 * lights up), and whether any reads the scene depth ({@link FXGraphNode.readsSceneDepth}).
 */
export function collectRenderCapabilities(graph: FXGraph<FXGraphNode>): FXRenderCapabilities {
  const intrinsics = new Set<string>();
  let sceneDepth = false;
  for (const id of collectReachableNodeIds(graph)) {
    const node = graph.getNode(id);
    if (node?.lightingIntrinsic !== undefined) {
      intrinsics.add(node.lightingIntrinsic);
    }
    sceneDepth ||= node?.readsSceneDepth ?? false;
  }
  return {
    lightingIntrinsics: [...intrinsics].sort((first, second) =>
      first < second ? -1 : first > second ? 1 : 0,
    ),
    sceneDepth,
  };
}
