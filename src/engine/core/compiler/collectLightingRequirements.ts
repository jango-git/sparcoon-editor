import type { FXGraph } from "../FXGraph";
import type { FXGraphNode } from "../FXGraphNode";
import { collectReachableNodeIds } from "./FXGraphTraversal.Internal";

/**
 * Unions the lighting intrinsics ({@link FXGraphNode.lightingIntrinsic}) declared by the
 * **reachable** nodes of a render graph. Empty => unlit; non-empty => the runtime lights up.
 */
export function collectLightingRequirements(graph: FXGraph<FXGraphNode>): readonly string[] {
  const reachable = collectReachableNodeIds(graph);
  const intrinsics = new Set<string>();
  for (const id of reachable) {
    const intrinsic = graph.getNode(id)?.lightingIntrinsic;
    if (intrinsic !== undefined) {
      intrinsics.add(intrinsic);
    }
  }
  return [...intrinsics].sort((first, second) => (first < second ? -1 : first > second ? 1 : 0));
}
