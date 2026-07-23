/**
 * Pure transform: the editor's authored graph -> the library's wire snapshot (editor is master,
 * library is a view). View-only data (node positions) is intentionally dropped here.
 */

import type { FXConnection, FXOutputBinding } from "../engine/core/FXGraph";
import type { FXGraphSnapshotData, FXNodeData } from "../engine/core/live/FXSnapshotData";
import { FX_SNAPSHOT_VERSION } from "../engine/core/live/FXSnapshotData";
import type { FXGLSLTypeName } from "../engine/core/socket/FXValueType";
import type { FXAttributeRequest } from "../engine/core/socket/FXAttribute";
import type { FXCompilerError } from "../engine/core/compiler/FXCompilerError";
import { collectUndeclaredAttributeErrors } from "../engine/core/compiler/collectAttributeRequests";
import type {
  AttributeTypeName,
  EditorAttribute,
  EditorGraph,
  GraphNode,
  GraphSocketReference,
  GraphOutputBinding,
} from "./graphModel";
import { ROUTE_INPUT_KEY, ROUTE_TYPE, isFakeNodeType } from "./fakeNodes";
import { attributeNameFromSlot, GraphKind, metaForNode } from "./nodePalette";
import { expandFamilyNode, nodeFamily, type ResolveWired } from "./nodeFamilies";
import { resolveInputType } from "./graphTypeResolution";
import { isSink } from "./sinks";

/**
 * `kind` disambiguates the (rare) non-unique node type for wire-driven family expansion
 * (split -> split-mat{N}); defaults safely since every matrix producer is `domain: "shared"`.
 */
export function serializeGraph(
  graph: EditorGraph,
  kind: GraphKind = GraphKind.Render,
): FXGraphSnapshotData {
  const resolveSource = makeRouteResolver(graph);
  const nodes: Record<string, FXNodeData> = {};
  // The reshaped input/output socket keys each real node actually exposes (family variant / sink
  // material), used below to drop wires left dangling after a shape shrink.
  const socketKeys = new Map<string, ResolvedSockets>();
  for (const node of Object.values(graph.nodes)) {
    if (isFakeNodeType(node.type)) {
      continue; // routes have no engine sockets; edges through them are resolved via resolveSource
    }
    const keys = resolvedSocketKeys(kind, node, graph);
    if (keys !== undefined) {
      socketKeys.set(node.id, keys);
    }
    // Sinks are editor-only nodes; the library models outputs as bindings, not nodes.
    if (isSink(node)) {
      continue;
    }
    // A family facade expands to its concrete engine variant here (combine/split -> combine-mat{N}/
    // split-mat{N}); an ordinary node emits verbatim. Socket keys are shared, so no rewrite needed.
    const resolveWired: ResolveWired = (inputKey) =>
      resolveInputType(kind, graph, node.id, inputKey, graph.attributes) as
        FXGLSLTypeName | undefined;
    nodes[node.id] = expandFamilyNode(node.type, node.parameters, resolveWired) ?? {
      type: node.type,
      params: node.parameters,
    };
  }

  // Whether a (known) node still exposes a socket. An unknown node is left alone (returns true), so
  // pruning only ever drops a genuinely-vanished endpoint, never a node the resolver can't map.
  const hasSocket = (nodeId: string, key: string, side: "input" | "output"): boolean => {
    const keys = socketKeys.get(nodeId);
    if (keys === undefined) {
      return true;
    }
    return (side === "output" ? keys.outputs : keys.inputs).has(key);
  };

  // An edge into a real target resolves its source back through any routes to the first real
  // producer; an edge whose target is a route is internal and dropped.
  const connections: FXConnection[] = [];
  for (const connection of graph.connections) {
    if (isRoute(graph, connection.to.nodeId)) {
      continue;
    }
    const from = resolveSource(connection.from);
    if (from === undefined) {
      continue;
    }
    // Drop a wire whose endpoint socket no longer exists on the reshaped node (a stale matrix
    // column after a facade narrowed) - the engine rejects an unknown socket and fails the whole graph.
    if (
      !hasSocket(from.nodeId, from.socketKey, "output") ||
      !hasSocket(connection.to.nodeId, connection.to.socketKey, "input")
    ) {
      continue;
    }
    connections.push({ from, to: connection.to });
  }

  const attributeTypes = new Map<string, AttributeTypeName>(
    graph.attributes.map((attribute) => [attribute.name, attribute.type]),
  );
  const outputBindings: FXOutputBinding[] = [];
  for (const binding of graph.outputBindings) {
    // Resolve the bound source through any routes to the real producer; a binding fed by a
    // dangling route resolves to nothing and is dropped.
    const from = resolveSource(binding.from);
    if (from === undefined) {
      continue;
    }
    // Same dangling-edge guard as connections: a binding fed by a producer socket that a reshape
    // removed (e.g. a split column that vanished) is dropped rather than emitted as an unknown source.
    if (!hasSocket(from.nodeId, from.socketKey, "output")) {
      continue;
    }
    const resolved: GraphOutputBinding = { ...binding, from };
    const name = attributeNameFromSlot(binding.slot);
    const type = name === undefined ? undefined : attributeTypes.get(name);
    if (name !== undefined && type !== undefined) {
      materializeAttributeWrite(resolved, name, type, nodes, connections, outputBindings);
      continue;
    }
    outputBindings.push({
      slot: resolved.slot,
      from: resolved.from,
      // Behavior bindings carry the sink phase through as an authoritative placement signal.
      ...(resolved.phase !== undefined ? { phase: resolved.phase } : {}),
    });
  }

  return { version: FX_SNAPSHOT_VERSION, nodes, connections, outputBindings };
}

interface ResolvedSockets {
  readonly inputs: ReadonlySet<string>;
  readonly outputs: ReadonlySet<string>;
}

/**
 * The input/output socket keys a node actually exposes after reshaping (family variant or plain
 * metadata). `undefined` for a type the palette can't resolve (its edges are then left untouched).
 */
function resolvedSocketKeys(
  kind: GraphKind,
  node: GraphNode,
  graph: EditorGraph,
): ResolvedSockets | undefined {
  const family = nodeFamily(node.type);
  if (family !== undefined) {
    const resolveWired: ResolveWired = (inputKey) =>
      resolveInputType(kind, graph, node.id, inputKey, graph.attributes) as
        FXGLSLTypeName | undefined;
    const shape = family.sockets(family.resolveVariant(node.parameters, resolveWired));
    return {
      inputs: new Set(shape.inputs.map((socket) => socket.key)),
      outputs: new Set(shape.outputs.map((socket) => socket.key)),
    };
  }
  const metadata = metaForNode(kind, node, graph.attributes);
  if (metadata === undefined) {
    return undefined;
  }
  return {
    inputs: new Set(metadata.inputs.map((socket) => socket.key)),
    outputs: new Set(metadata.outputs.map((socket) => socket.key)),
  };
}

function isRoute(graph: EditorGraph, nodeId: string): boolean {
  return graph.nodes[nodeId]?.type === ROUTE_TYPE;
}

/**
 * Follows a socket reference back through any chain of routes (a route forwards its `in`
 * socket) to the first real producer's output. Cycle-guarded; returns `undefined` when a route
 * in the chain has no input (a dangling reroute).
 */
function makeRouteResolver(
  graph: EditorGraph,
): (ref: GraphSocketReference) => GraphSocketReference | undefined {
  // Each route's single incoming edge (into its `in` socket), keyed by route id.
  const routeInput = new Map<string, GraphSocketReference>();
  for (const connection of graph.connections) {
    if (isRoute(graph, connection.to.nodeId) && connection.to.socketKey === ROUTE_INPUT_KEY) {
      routeInput.set(connection.to.nodeId, connection.from);
    }
  }
  return (ref) => {
    let current: GraphSocketReference | undefined = ref;
    const seen = new Set<string>();
    while (current !== undefined && isRoute(graph, current.nodeId)) {
      if (seen.has(current.nodeId)) {
        return undefined; // Cyclic reroute - bail rather than loop forever.
      }
      seen.add(current.nodeId);
      current = routeInput.get(current.nodeId);
    }
    return current;
  };
}

/**
 * Rewrites a wire into a behavior sink's `attr:<name>` slot to the engine's shape: the producer
 * feeds a synthetic `store-attribute` node, deterministically id'd so a re-serialize is stable.
 */
function materializeAttributeWrite(
  binding: GraphOutputBinding,
  name: string,
  type: AttributeTypeName,
  nodes: Record<string, FXNodeData>,
  connections: FXConnection[],
  outputBindings: FXOutputBinding[],
): void {
  const phase = binding.phase ?? "spawn";
  const storeId = `store:${binding.slot}:${phase}:${binding.from.nodeId}.${binding.from.socketKey}`;
  nodes[storeId] = { type: "store-attribute", params: { name, type, phase } };
  connections.push({ from: binding.from, to: { nodeId: storeId, socketKey: "value" } });
  outputBindings.push({ slot: binding.slot, from: { nodeId: storeId, socketKey: "value" }, phase });
}

/**
 * Flags a `render`/`behavior` request naming (or mistyping) an attribute outside `declared` -
 * e.g. an orphaned `read-attribute` node after its declaration was removed or retyped elsewhere.
 * Shared by the live preview and the TypeScript export, so a stale reference is refused in both.
 */
export function undeclaredAttributeErrors(
  render: readonly FXAttributeRequest[],
  behavior: readonly FXAttributeRequest[],
  declared: readonly EditorAttribute[],
): readonly FXCompilerError[] {
  const declaredTypes = new Map(declared.map((attribute) => [attribute.name, attribute.type]));
  return [
    ...collectUndeclaredAttributeErrors(render, declaredTypes),
    ...collectUndeclaredAttributeErrors(behavior, declaredTypes),
  ];
}
