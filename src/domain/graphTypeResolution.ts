/**
 * The concrete type a generic (`"T"`) socket carries, inferred by walking the authored graph -
 * mirrors the engine's `resolveGenerics` at compile time, without a live compile.
 */

import { genericWinner } from "../engine/core/compiler/FXTypeResolve.Internal";
import { type FXGLSLTypeName, literalGenericType } from "../engine/core/socket/FXValueType";
import {
  type EditorAttribute,
  type EditorGraph,
  type GraphNode,
  incomingConnection,
} from "./graphModel";
import { nodeFamily, type ResolveWired } from "./nodeFamilies";
import type { FXNodeMeta, GraphKind } from "./nodePalette";
import { metaForNode } from "./nodePalette";

/**
 * The concrete type a generic node resolves its `"T"` to: its structural `valueType` parameter when it
 * has one, else the type wired into its generic inputs as the engine picks it ({@link genericWinner}),
 * recursively, else the one its inline values imply ({@link literalGenericType}). Cycle-guarded via
 * `visited`.
 */
export function resolveNodeType(
  kind: GraphKind,
  node: GraphNode,
  metadata: FXNodeMeta,
  graph: EditorGraph,
  attributes: readonly EditorAttribute[],
  visited: Set<string>,
): string | undefined {
  if (visited.has(node.id)) {
    return undefined;
  }
  visited.add(node.id);

  // The UI-only `"color"` alias is a color-picker-edited vec4; normalize it here exactly as the
  // engine does at parameter resolution, else the editor would reject its wire into a vecN input.
  for (const [key, parameter] of Object.entries(metadata.params)) {
    if (parameter.kind === "structural" && parameter.type === "valueType") {
      const annotated = String(node.parameters[key] ?? parameter.default);
      return annotated === "color" ? "vec4" : annotated;
    }
  }

  // Otherwise infer from the concrete types wired into the generic inputs, the engine's way: the
  // first one, or the first vector when a scalar comes before it (the scalar splats).
  const wired: { readonly id: string }[] = [];
  for (const input of metadata.inputs) {
    if (input.type !== "T") {
      continue;
    }
    const source = incomingConnection(graph, node.id, input.key)?.from;
    if (source === undefined) {
      continue;
    }
    const sourceType = resolveSocketType(
      kind,
      source.nodeId,
      source.socketKey,
      graph,
      attributes,
      visited,
    );
    if (sourceType !== undefined && sourceType !== "T") {
      wired.push({ id: sourceType });
    }
  }
  if (wired.length > 0) {
    return genericWinner(wired)?.id;
  }
  // Nothing wired: the inline values typed into the generic inputs decide, as in the engine.
  const implied = literalGenericType(
    metadata.inputs
      .filter((input) => input.type === "T")
      .map((input) => node.parameters[input.key] ?? input.control?.default),
  );
  return implied !== undefined && metadata.generic?.constraint.includes(implied) === true
    ? implied
    : undefined;
}

/** The concrete type carried by one socket, resolving a generic port through its node. */
export function resolveSocketType(
  kind: GraphKind,
  nodeId: string,
  socketKey: string,
  graph: EditorGraph,
  attributes: readonly EditorAttribute[],
  visited: Set<string>,
): string | undefined {
  const node = graph.nodes[nodeId];
  if (node === undefined) {
    return undefined;
  }
  const metadata = metaForNode(kind, node, attributes);
  if (metadata === undefined) {
    return undefined;
  }
  // A family facade reshapes its sockets for the resolved variant (a matrix `split`'s columns are
  // `vecN`, not `float`); `visited` guards re-entry so a cycle through the facade's own input terminates.
  const family = nodeFamily(node.type);
  if (family !== undefined && !visited.has(nodeId)) {
    visited.add(nodeId);
    const resolveWired: ResolveWired = (inputKey) => {
      const source = incomingConnection(graph, nodeId, inputKey)?.from;
      if (source === undefined) {
        return undefined;
      }
      const wired = resolveSocketType(
        kind,
        source.nodeId,
        source.socketKey,
        graph,
        attributes,
        visited,
      );
      return wired === undefined || wired === "T" ? undefined : (wired as FXGLSLTypeName);
    };
    const shape = family.sockets(family.resolveVariant(node.parameters, resolveWired));
    const reshaped =
      shape.outputs.find((candidate) => candidate.key === socketKey) ??
      shape.inputs.find((candidate) => candidate.key === socketKey);
    if (reshaped !== undefined) {
      return reshaped.type;
    }
  }
  const socket =
    metadata.outputs.find((candidate) => candidate.key === socketKey) ??
    metadata.inputs.find((candidate) => candidate.key === socketKey);
  if (socket === undefined) {
    return undefined;
  }
  if (socket.type !== "T") {
    return socket.type;
  }
  return resolveNodeType(kind, node, metadata, graph, attributes, visited);
}

/**
 * The concrete type wired into an input socket, or `undefined` when unconnected/undeterminable -
 * the hook a wire-driven node family (e.g. `split`) uses to follow its input's type.
 */
export function resolveInputType(
  kind: GraphKind,
  graph: EditorGraph,
  nodeId: string,
  inputKey: string,
  attributes: readonly EditorAttribute[] = [],
): string | undefined {
  const source = incomingConnection(graph, nodeId, inputKey)?.from;
  if (source === undefined) {
    return undefined;
  }
  const resolved = resolveSocketType(
    kind,
    source.nodeId,
    source.socketKey,
    graph,
    attributes,
    new Set(),
  );
  return resolved === "T" ? undefined : resolved;
}
