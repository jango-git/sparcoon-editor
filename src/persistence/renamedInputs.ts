/**
 * Node inputs (and outputs) renamed since projects started being saved. A saved project names an
 * input in two places - the inline value in the node's `parameters` and the `to.socketKey` of a
 * wire feeding it - and an output in the `from.socketKey` of every wire or sink binding reading it,
 * so a rename that only touched the node definition would silently drop them on load: the value
 * back to its default, the wire as dangling. Loading maps every old key to its new one before
 * anything else reads the graph.
 */

import type { EditorGraph, GraphConnection, GraphNode } from "../domain/graphModel";
import { isRecord } from "../util/guards";

/** Node type -> old input key -> current input key. */
const RENAMED_INPUTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // Named like spawn-cone's, which measures the same axis-long dimension.
  "spawn-cylinder": { length: "height" },
};

/**
 * Node type -> old output key -> current output key: a wire (or a sink binding) reading a renamed
 * output names it in its `from.socketKey`. A new name never reuses an old one, so a file saved
 * after the rename is never migrated again.
 */
const RENAMED_OUTPUTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // "previous" was the frame the playhead is on and "current" the one after it.
  "animated-texture": { uvPrevious: "uvFrame", uvCurrent: "uvNext" },
};

/**
 * `table[key]` when `table` itself holds it. Every key read here comes from a stored file, so a
 * plain index would hand back `Object.prototype` members for keys like `"constructor"`.
 */
function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** A stored node's type, or `undefined` for one too damaged to have one (left as it is). */
function typeOf(node: unknown): string | undefined {
  return isRecord(node) && typeof node["type"] === "string" ? node["type"] : undefined;
}

function migrateNode(node: GraphNode, renames: Readonly<Record<string, string>>): GraphNode {
  if (!isRecord(node.parameters)) {
    return node;
  }
  const parameters: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node.parameters)) {
    const current = own(renames, key) ?? key;
    // A file that somehow holds both keys keeps the current one.
    if (current !== key && Object.hasOwn(node.parameters, current)) {
      continue;
    }
    parameters[current] = value;
  }
  return { ...node, parameters };
}

/** `graph` with every renamed input's stored value and incoming wire, and every wire or sink binding
 *  reading a renamed output, under its current key. */
export function migrateRenamedInputs(graph: EditorGraph): EditorGraph {
  const renamesOf = (node: unknown): Readonly<Record<string, string>> | undefined => {
    const type = typeOf(node);
    return type !== undefined ? own(RENAMED_INPUTS, type) : undefined;
  };
  const outputRenamesOf = (node: unknown): Readonly<Record<string, string>> | undefined => {
    const type = typeOf(node);
    return type !== undefined ? own(RENAMED_OUTPUTS, type) : undefined;
  };
  if (
    !Object.values(graph.nodes).some(
      (node) => renamesOf(node) !== undefined || outputRenamesOf(node) !== undefined,
    )
  ) {
    return graph;
  }
  /** `from` under its output's current key (unchanged when not renamed). */
  const renamedFrom = <T extends { readonly nodeId: string; readonly socketKey: string }>(
    from: T,
  ): T => {
    const renames = outputRenamesOf(own(graph.nodes, from.nodeId));
    const socketKey = renames === undefined ? undefined : own(renames, from.socketKey);
    return socketKey === undefined ? from : { ...from, socketKey };
  };

  const nodes: Record<string, GraphNode> = {};
  for (const [id, node] of Object.entries(graph.nodes)) {
    const renames = renamesOf(node);
    nodes[id] = renames !== undefined ? migrateNode(node, renames) : node;
  }
  const connections = graph.connections.map((connection): GraphConnection => {
    if (!isRecord(connection) || !isRecord(connection.to)) {
      return connection;
    }
    const renames = renamesOf(own(graph.nodes, connection.to.nodeId));
    const socketKey =
      (renames === undefined ? undefined : own(renames, connection.to.socketKey)) ??
      connection.to.socketKey;
    const to =
      socketKey === connection.to.socketKey ? connection.to : { ...connection.to, socketKey };
    const from = isRecord(connection.from) ? renamedFrom(connection.from) : connection.from;
    return to === connection.to && from === connection.from
      ? connection
      : { ...connection, from, to };
  });
  const outputBindings = graph.outputBindings.map((binding) => {
    if (!isRecord(binding) || !isRecord(binding.from)) {
      return binding;
    }
    const from = renamedFrom(binding.from);
    return from === binding.from ? binding : { ...binding, from };
  });
  return { ...graph, nodes, connections, outputBindings };
}
