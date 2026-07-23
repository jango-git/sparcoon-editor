/**
 * The concrete type a generic (`"T"`) socket carries, inferred by walking the authored graph -
 * mirrors the engine's `resolveGenerics` at compile time, without a live compile.
 */

import {
  incomingConnection,
  type EditorAttribute,
  type EditorGraph,
  type GraphNode,
} from "./graphModel";
import type { FXGLSLTypeName } from "../engine/core/socket/FXValueType";
import type { FXNodeMeta, GraphKind } from "./nodePalette";
import { metaForNode } from "./nodePalette";
import { nodeFamily, type ResolveWired } from "./nodeFamilies";

/**
 * The concrete type a generic node resolves its `"T"` to: its structural `valueType` parameter when it
 * has one, else the type of the first connected generic input (recursively). Cycle-guarded via `visited`.
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

  // Otherwise infer from whatever concrete type is wired into a generic input.
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
      return sourceType;
    }
  }
  return undefined;
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
