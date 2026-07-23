/**
 * Visual type resolution for the polymorphic (`generic`) nodes. The engine unifies a node's `"T"`
 * sockets to a concrete GLSL type at compile time; the editor mirrors that *for display* so a
 * generic node's sockets are colored by the type actually flowing through them, and the
 * width-driven nodes show the right number of ports:
 *
 * - Constant - `T` comes from its `type` param; the output dot takes that color.
 * - Binary Op / Clamp / Mix / ... - `T` is inferred from whatever is wired into a generic input,
 *   so `out` (and the still-generic inputs) recolor to match.
 * - Combine / Split - family facades (see `nodeFamilies`): the variant is chosen by combine's
 *   `type` param or by the type wired into split's input, and it dictates the component sockets
 *   (a `vecN` is N floats; a `matN` is N `vecN` columns).
 *
 * Purely cosmetic + port-count: the serialized snapshot still carries only params and connections,
 * and the engine re-infers types on its own (the recursive resolver itself lives in
 * `domain/graphTypeResolution`, shared with serialize). {@link resolveNodeMeta} returns metadata with
 * `"T"` replaced by the resolved type (left as `"T"` when it cannot be determined).
 */

import type { EditorAttribute, EditorGraph, GraphNode } from "../../domain/graphModel";
import type { FXGLSLTypeName } from "../../engine/core/socket/FXValueType";
import type { FXNodeMeta, FXParamMeta, FXSocketMeta, GraphKind } from "../../domain/nodePalette";
import {
  DEFAULT_RENDER_HOST,
  metaForNode,
  ROUTE_TYPE,
  type RenderHost,
} from "../../domain/nodePalette";
import { ROUTE_OUTPUT_KEY } from "../../domain/fakeNodes";
import { nodeFamily, type ResolveWired } from "../../domain/nodeFamilies";
import {
  resolveInputType,
  resolveNodeType,
  resolveSocketType,
} from "../../domain/graphTypeResolution";

/**
 * The node's metadata reshaped for display: a family facade (combine/split) takes its whole socket
 * shape from {@link nodeFamily} for the resolved variant (param-driven for combine, wired-input for
 * split); any other generic node has its `"T"` sockets substituted for the resolved concrete type
 * (left `"T"` when undeterminable). A non-generic node is returned unchanged.
 */
export function resolveNodeMeta(
  kind: GraphKind,
  node: GraphNode,
  graph: EditorGraph,
  attributes: readonly EditorAttribute[] = [],
  host: RenderHost = DEFAULT_RENDER_HOST,
  meshAssetNames: readonly string[] = [],
): FXNodeMeta | undefined {
  // `host` only reshapes the render sink (a non-generic terminus), so it is consumed here and not
  // threaded into the generic/family recursion below - none of which ever resolves the sink.
  const base = metaForNode(kind, node, attributes, host, meshAssetNames);
  if (base?.generic === undefined) {
    return base;
  }

  const family = nodeFamily(node.type);
  if (family !== undefined) {
    const resolveWired: ResolveWired = (inputKey) =>
      resolveInputType(kind, graph, node.id, inputKey, attributes) as FXGLSLTypeName | undefined;
    const shape = family.sockets(family.resolveVariant(node.parameters, resolveWired));
    // A param-driven facade (combine) offers the family's full `type` menu; the engine descriptor
    // lists only the vector options, the matrix ones live in the editor facade.
    let params: Readonly<Record<string, FXParamMeta>> = base.params;
    if (family.typeParamKey !== undefined) {
      const typeParam = base.params[family.typeParamKey];
      if (typeParam?.type === "valueType") {
        params = {
          ...base.params,
          [family.typeParamKey]: { ...typeParam, options: [...family.options] },
        };
      }
    }
    return { ...base, inputs: [...shape.inputs], outputs: [...shape.outputs], params };
  }

  const resolved = resolveNodeType(kind, node, base, graph, attributes, new Set());
  const substitute = (socket: FXSocketMeta): FXSocketMeta =>
    socket.type === "T" && resolved !== undefined
      ? { ...socket, type: resolved as FXSocketMeta["type"] }
      : socket;
  return { ...base, inputs: base.inputs.map(substitute), outputs: base.outputs.map(substitute) };
}

/**
 * The concrete type flowing through a route, resolved from whatever feeds its `in` socket
 * (recursively, so a chain of routes reports its ultimate source type). `undefined` when the
 * route is unconnected or the source type cannot be determined. A route's own metadata is a
 * generic pass-through (see {@link routeMeta}), so resolving its output socket walks straight
 * back through its input to the producer.
 */
export function resolveRouteType(
  kind: GraphKind,
  graph: EditorGraph,
  routeId: string,
  attributes: readonly EditorAttribute[] = [],
): string | undefined {
  const resolved = resolveSocketType(kind, routeId, ROUTE_OUTPUT_KEY, graph, attributes, new Set());
  return resolved === "T" ? undefined : resolved;
}

/** The type a route carries, traced from its input (`"T"` when unconnected / undeterminable). */
export function carriedTypeForRoute(kind: GraphKind, graph: EditorGraph, routeId: string): string {
  return resolveRouteType(kind, graph, routeId, graph.attributes) ?? "T";
}

/**
 * The concrete type a socket carries, for wire color and drop-compatibility. Route-aware: a route
 * reports whatever flows through it (its pass-through metadata is generic), while a generic node socket
 * resolves to the type actually flowing. `undefined` when the node/socket cannot be found.
 */
export function resolveSocketCarriedType(
  kind: GraphKind,
  graph: EditorGraph,
  nodeId: string,
  socketKey: string,
  side: "input" | "output",
): string | undefined {
  const node = graph.nodes[nodeId];
  if (node === undefined) {
    return undefined;
  }
  if (node.type === ROUTE_TYPE) {
    return carriedTypeForRoute(kind, graph, nodeId);
  }
  const metadata = resolveNodeMeta(kind, node, graph, graph.attributes);
  const sockets = side === "output" ? metadata?.outputs : metadata?.inputs;
  return sockets?.find((candidate) => candidate.key === socketKey)?.type;
}

/** A signature of a resolved metadata's socket shape - a change forces a node-view rebuild. */
export function socketShapeSignature(metadata: FXNodeMeta | undefined): string {
  if (metadata === undefined) {
    return "";
  }
  const ports = (sockets: readonly FXSocketMeta[]): string =>
    sockets.map((socket) => `${socket.key}:${socket.type}`).join(",");
  return `${ports(metadata.inputs)}|${ports(metadata.outputs)}`;
}
