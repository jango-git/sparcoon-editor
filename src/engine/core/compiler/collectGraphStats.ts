import type { FXGraph } from "../FXGraph";
import type { FXGraphNode } from "../FXGraphNode";
import { collectReachableNodeIds, topologicalOrder } from "./FXGraphTraversal.Internal";
import { resolveGenerics } from "./FXTypeResolve.Internal";

/** Node count + total complexity of a graph's reachable subgraph (see {@link FXGraphNode.estimateCost}). */
export interface FXGraphStats {
  /** Nodes actually reachable from an output binding - what would compile, not what merely exists. */
  readonly nodeCount: number;
  /** Sum of each reachable node's {@link FXGraphNode.estimateCost}, at its graph-resolved type. */
  readonly cost: number;
}

/**
 * Sums {@link FXGraphNode.estimateCost} over a graph's **reachable** nodes only, resolving each
 * node's generic `T` first so a `vec3` op's cost reflects its true width, not a guess.
 */
export function collectGraphStats(graph: FXGraph<FXGraphNode>): FXGraphStats {
  const reachable = collectReachableNodeIds(graph);
  const { order } = topologicalOrder(graph, reachable);
  const { types } = resolveGenerics(graph, order);

  let cost = 0;
  for (const id of reachable) {
    cost += graph.getNode(id)?.estimateCost?.(types.get(id)) ?? 0;
  }
  return { nodeCount: reachable.size, cost };
}
