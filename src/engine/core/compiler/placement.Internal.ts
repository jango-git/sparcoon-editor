import type { FXGraph, FXOutputBinding } from "../FXGraph";
import type { FXGraphNode } from "../FXGraphNode";

/**
 * Backend policy for {@link resolvePlacement}: how a node's placement "slot" (render shader
 * stage, behavior phase) is decided. Core owns the traversal; the backend supplies lattice rules.
 */
export interface FXPlacementPolicy<N extends FXGraphNode, Slot> {
  /** Whether the node has no intrinsic slot and is placed by its consumers. */
  isFlexible(node: N): boolean;
  /** The declared slot of a fixed (non-flexible) node. */
  fixedSlot(node: N): Slot;
  /**
   * Slot for a flexible node, from its already-resolved consumers' slots and the output-slot
   * bindings it fills. Called in reverse-topo order, so every consumer is resolved first.
   */
  resolveFlexible(
    node: N,
    consumerSlots: readonly (Slot | undefined)[],
    bindings: readonly FXOutputBinding[],
  ): Slot;
}

/**
 * Infers the placement slot of every reachable node in reverse topological order (consumers
 * resolved first). Skeleton behind `resolvePlacementStages`/`resolvePlacementPhases`.
 */
export function resolvePlacement<N extends FXGraphNode, Slot>(
  graph: FXGraph<N>,
  order: readonly string[],
  policy: FXPlacementPolicy<N, Slot>,
): Map<string, Slot> {
  const resolved = new Map<string, Slot>();
  const reverseOrder = [...order].reverse();
  for (const id of reverseOrder) {
    const node = graph.getNode(id);
    if (node === undefined) {
      continue;
    }
    if (!policy.isFlexible(node)) {
      resolved.set(id, policy.fixedSlot(node));
      continue;
    }
    const consumerSlots: (Slot | undefined)[] = [];
    for (const connection of graph.connections) {
      if (connection.from.nodeId === id) {
        consumerSlots.push(resolved.get(connection.to.nodeId));
      }
    }
    const bindings = graph.outputBindings.filter((binding) => binding.from.nodeId === id);
    resolved.set(id, policy.resolveFlexible(node, consumerSlots, bindings));
  }
  return resolved;
}
