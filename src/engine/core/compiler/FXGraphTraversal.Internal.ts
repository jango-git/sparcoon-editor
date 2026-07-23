import type { FXGraph } from "../FXGraph";

/**
 * Node ids reachable upstream from the graph's output bindings via input connections. Includes
 * dangling ids referenced by a connection with no node instance, so validation can flag them.
 */
export function collectReachableNodeIds(graph: FXGraph): Set<string> {
  const reachable = new Set<string>();
  const stack: string[] = [];

  for (const binding of graph.outputBindings) {
    stack.push(binding.from.nodeId);
  }

  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || reachable.has(id)) {
      continue;
    }
    reachable.add(id);

    const node = graph.getNode(id);
    if (node === undefined) {
      continue;
    }
    for (const input of node.inputs) {
      const connection = graph.sourceOf({ nodeId: id, socketKey: input.key });
      if (connection !== undefined) {
        stack.push(connection.from.nodeId);
      }
    }
  }

  return reachable;
}

/** Result of {@link topologicalOrder}. */
export interface FXTopologicalResult {
  /** Node ids ordered dependencies-first; empty tail is dropped on a cycle. */
  readonly order: readonly string[];
  /** Set to a node on a detected cycle, otherwise `undefined`. */
  readonly cycleNodeId: string | undefined;
}

/**
 * Depth-first topological sort over the reachable subgraph (dependencies before dependents).
 * Detects the first back-edge; `order` is only complete when `cycleNodeId` is `undefined`.
 */
export function topologicalOrder(
  graph: FXGraph,
  reachable: ReadonlySet<string>,
): FXTopologicalResult {
  const order: string[] = [];
  // 1 = on the current DFS path, 2 = fully processed
  const state = new Map<string, number>();
  let cycleNodeId: string | undefined;

  // Iterative two-phase frame stack (enter: mark on-path, push deps; exit: mark processed,
  // emit) - a deep graph chain must not overflow the JS call stack on every editor snapshot.
  interface Frame {
    readonly id: string;
    entered: boolean;
  }

  for (const rootId of reachable) {
    if (cycleNodeId !== undefined) {
      break;
    }
    const stack: Frame[] = [{ id: rootId, entered: false }];
    while (stack.length > 0) {
      // Pop, then re-push before diving into dependencies: the `entered` flag decides whether
      // this frame finishes here (already re-visited) or dives into its dependencies (re-pushed
      // below deps). Popping (instead of peeking the top) lets TypeScript prove `frame` is
      // defined via the guard, matching the `stack.length > 0` invariant the loop already holds.
      const frame = stack.pop();
      if (frame === undefined) {
        continue;
      }
      if (frame.entered) {
        state.set(frame.id, 2);
        order.push(frame.id);
        continue;
      }

      const marked = state.get(frame.id);
      if (marked === 2) {
        continue;
      }
      if (marked === 1) {
        // Only an ancestor still on the path can hold state 1 here - a back-edge.
        cycleNodeId = frame.id;
        break;
      }

      state.set(frame.id, 1);
      frame.entered = true;
      stack.push(frame);
      const node = graph.getNode(frame.id);
      if (node !== undefined) {
        // Push dependencies reversed so they are entered in declared input order.
        for (const input of [...node.inputs].reverse()) {
          const connection = graph.sourceOf({ nodeId: frame.id, socketKey: input.key });
          if (connection !== undefined && reachable.has(connection.from.nodeId)) {
            stack.push({ id: connection.from.nodeId, entered: false });
          }
        }
      }
    }
  }

  return { order, cycleNodeId };
}
