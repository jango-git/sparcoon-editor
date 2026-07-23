import type { FXGraph } from "../FXGraph";
import type { FXGraphNode } from "../FXGraphNode";
import type { FXSocketDescriptor } from "../socket/FXSocket";
import type { FXValueType } from "../socket/FXValueType";
import { isGenericType, isNumericType, resolveValueType } from "../socket/FXValueType";
import type { FXCompilerError } from "./FXCompilerError";
import { outputSocket } from "./FXSocketIndex.Internal";

/**
 * Outcome of {@link resolveGenerics}. A node absent from `types` either has no generic
 * socket or failed to resolve (an error was recorded).
 */
export interface FXTypeResolution {
  readonly types: ReadonlyMap<string, FXValueType>;
  readonly errors: readonly FXCompilerError[];
}

/**
 * The concrete type a socket carries, resolving the node's generic `T` through `types`
 * when the socket is generic. `undefined` when the node failed to resolve.
 */
export function socketConcreteType(
  nodeId: string,
  socket: FXSocketDescriptor,
  types: ReadonlyMap<string, FXValueType>,
): FXValueType | undefined {
  return isGenericType(socket.type) ? types.get(nodeId) : socket.type;
}

/**
 * Per-node structural-hash tag encoding the resolved `T`, so two differently-shaped
 * instances of a generic node hash apart. Empty when unresolved.
 */
export function genericTypeTag(types: ReadonlyMap<string, FXValueType>, nodeId: string): string {
  const type = types.get(nodeId);
  return type === undefined ? "" : `T=${type.id}`;
}

/** Whether a node exposes any generic socket (input or output). */
function hasGenericSocket(node: FXGraphNode): boolean {
  return (
    node.inputs.some((socket) => isGenericType(socket.type)) ||
    node.outputs.some((socket) => isGenericType(socket.type))
  );
}

/**
 * Unifies each reachable node's generic `T` to a concrete {@link FXValueType}, in topological
 * order; falls back to {@link FXGraphNode.resolveGenericHint} when no connected generic input.
 */
export function resolveGenerics(graph: FXGraph, order: readonly string[]): FXTypeResolution {
  const types = new Map<string, FXValueType>();
  const errors: FXCompilerError[] = [];

  for (const id of order) {
    const node = graph.getNode(id);
    if (node === undefined || !hasGenericSocket(node)) {
      continue;
    }

    // One type variable per node: any generic socket carries the same constraint.
    const constraint = genericConstraintOf(node);

    const candidates: { type: FXValueType; socketKey: string }[] = [];
    // Tracked alongside `candidates` (rather than read back via candidates[0]) so
    // TypeScript can prove it non-null below without a non-null assertion.
    let first: FXValueType | undefined;
    for (const socket of node.inputs) {
      if (!isGenericType(socket.type)) {
        continue;
      }
      const connection = graph.sourceOf({ nodeId: id, socketKey: socket.key });
      if (connection === undefined) {
        continue;
      }
      const source = graph.getNode(connection.from.nodeId);
      if (source === undefined) {
        continue;
      }
      const sourceOutput = outputSocket(source, connection.from.socketKey);
      if (sourceOutput === undefined) {
        continue;
      }
      const sourceType = socketConcreteType(connection.from.nodeId, sourceOutput, types);
      if (sourceType !== undefined) {
        candidates.push({ type: sourceType, socketKey: socket.key });
        first ??= sourceType;
      }
    }

    let resolved: FXValueType | undefined;
    if (first !== undefined) {
      // First connected generic input fixes `T`; the rest coerce at readInput, so
      // differing numeric widths are not a conflict - only numeric-vs-opaque is.
      const conflict = candidates.find(
        (candidate) =>
          candidate.type.id !== first.id &&
          !(isNumericType(candidate.type) && isNumericType(first)),
      );
      if (conflict !== undefined) {
        errors.push({
          code: "generic-type-conflict",
          message: `node "${id}" has generic inputs of conflicting types (${first.id} vs ${conflict.type.id})`,
          nodeId: id,
          socketKey: conflict.socketKey,
        });
      }
      resolved = first;
    } else {
      const hint = node.resolveGenericHint?.();
      if (hint !== undefined) {
        resolved = resolveValueType(hint);
      }
    }

    if (resolved === undefined) {
      errors.push({
        code: "generic-type-unresolved",
        message: `generic type of node "${id}" cannot be inferred (no typed generic input and no explicit type annotation)`,
        nodeId: id,
      });
      continue;
    }

    if (constraint !== undefined && !constraint.includes(resolved.id)) {
      errors.push({
        code: "generic-type-conflict",
        message: `node "${id}" resolved to ${resolved.id}, which is outside its constraint [${constraint.join(", ")}]`,
        nodeId: id,
      });
    }

    types.set(id, resolved);
  }

  return { types, errors };
}

/** The constraint of a node's generic type variable, taken from any generic socket. */
function genericConstraintOf(node: FXGraphNode): readonly string[] | undefined {
  for (const socket of [...node.inputs, ...node.outputs]) {
    if (isGenericType(socket.type)) {
      return socket.type.constraint;
    }
  }
  return undefined;
}
