import type { FXGraph } from "../FXGraph";
import type { FXGraphNode } from "../FXGraphNode";
import { collectReachableNodeIds } from "./FXGraphTraversal.Internal";

/**
 * Unions the host builtins ({@link FXGraphNode.targetReads}) the nodes feeding output `slots` may
 * read - what those outputs can depend on, e.g. whether a transform output follows `modelMatrix`.
 */
export function collectSlotReads(
  graph: FXGraph<FXGraphNode>,
  slots: readonly string[],
): ReadonlySet<string> {
  const reads = new Set<string>();
  for (const id of collectReachableNodeIds(graph, slots)) {
    for (const name of graph.getNode(id)?.targetReads ?? []) {
      reads.add(name);
    }
  }
  return reads;
}
