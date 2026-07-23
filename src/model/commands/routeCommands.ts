/**
 * Route (reroute knot) commands. A route is a fake pass-through node that tidies an edge's layout;
 * `serialize.ts` splices it back out, so inserting/dissolving one never changes what compiles
 * (structural: it rewires).
 */

import type {
  GraphConnection,
  GraphNode,
  GraphOutputBinding,
  GraphPosition,
  GraphSocketReference,
} from "../../domain/graphModel";
import { ROUTE_INPUT_KEY, ROUTE_OUTPUT_KEY, ROUTE_TYPE } from "../../domain/fakeNodes";
import type { Store } from "../store";
import { nextIdentifier } from "./identifier";
import { activeGraph, bindingMatches, withGraph, type GraphSlot } from "./graphAccess.Internal";

/** Builds a fresh route node at `position` (top-left in graph coordinates). */
function makeRouteNode(position: GraphPosition): GraphNode {
  return { id: nextIdentifier("route"), type: ROUTE_TYPE, parameters: {}, position };
}

/** A fresh route node plus the edge feeding its input from the producer socket `from`. */
function makeRouteWithInbound(
  from: GraphSocketReference,
  position: GraphPosition,
): { readonly route: GraphNode; readonly inbound: GraphConnection } {
  const route = makeRouteNode(position);
  const inbound: GraphConnection = {
    id: nextIdentifier("conn"),
    from,
    to: { nodeId: route.id, socketKey: ROUTE_INPUT_KEY },
  };
  return { route, inbound };
}

/**
 * Inserts a route onto edge `A=>B`, splitting it into `A=>route.in` and `route.out=>B` at
 * `position`. No-op for an unknown connection id. Returns the new route node id.
 */
export function insertRouteOnConnection(
  store: Store,
  slot: GraphSlot,
  connectionId: string,
  position: GraphPosition,
): string | undefined {
  const graph = activeGraph(store.getSource(), slot);
  const target = graph.connections.find((connection) => connection.id === connectionId);
  if (target === undefined) {
    return undefined;
  }
  const { route, inbound } = makeRouteWithInbound(target.from, position);
  const outbound: GraphConnection = {
    id: nextIdentifier("conn"),
    from: { nodeId: route.id, socketKey: ROUTE_OUTPUT_KEY },
    to: target.to,
  };
  const next = withGraph(store.getSource(), slot, (current) => ({
    ...current,
    nodes: { ...current.nodes, [route.id]: route },
    connections: [
      ...current.connections.filter((connection) => connection.id !== connectionId),
      inbound,
      outbound,
    ],
  }));
  store.commit(next, "structural");
  return route.id;
}

/**
 * Dissolves a route: every edge it fed reconnects straight to whatever fed its input, then the
 * route is removed (one with no input just vanishes, dropping its outbound edges). No-op for a non-route id.
 */
export function dissolveRoute(store: Store, slot: GraphSlot, routeId: string): void {
  const graph = activeGraph(store.getSource(), slot);
  if (graph.nodes[routeId]?.type !== ROUTE_TYPE) {
    return;
  }
  const inbound = graph.connections.find(
    (connection) => connection.to.nodeId === routeId && connection.to.socketKey === ROUTE_INPUT_KEY,
  );
  const source = inbound?.from;
  const fromRoute = (ref: GraphSocketReference): boolean =>
    ref.nodeId === routeId && ref.socketKey === ROUTE_OUTPUT_KEY;
  const next = withGraph(store.getSource(), slot, (current) => {
    const nodes = { ...current.nodes };
    delete nodes[routeId];
    return {
      ...current,
      nodes,
      connections: current.connections.flatMap((connection) => {
        // Drop the route's own inbound edge and any edge touching the route at either end,
        // re-emitting an outbound edge rerouted to the real source when one exists.
        if (connection.to.nodeId === routeId) {
          return [];
        }
        if (fromRoute(connection.from)) {
          return source === undefined ? [] : [{ ...connection, from: source }];
        }
        return [connection];
      }),
      outputBindings: current.outputBindings.flatMap((binding) =>
        fromRoute(binding.from)
          ? source === undefined
            ? []
            : [{ ...binding, from: source }]
          : [binding],
      ),
    };
  });
  store.commit(next, "structural");
}

/**
 * Inserts a route onto binding `boundSlot`/`phase` (identifies which of the two behavior sinks):
 * the producer now feeds `route.in`, the sink rebinds to `route.out`. No-op if none exists.
 */
export function insertRouteOnBinding(
  store: Store,
  slot: GraphSlot,
  boundSlot: string,
  phase: "spawn" | "update" | undefined,
  position: GraphPosition,
): string | undefined {
  const graph = activeGraph(store.getSource(), slot);
  const target = graph.outputBindings.find((binding) => bindingMatches(binding, boundSlot, phase));
  if (target === undefined) {
    return undefined;
  }
  const { route, inbound } = makeRouteWithInbound(target.from, position);
  const next = withGraph(store.getSource(), slot, (current) => ({
    ...current,
    nodes: { ...current.nodes, [route.id]: route },
    connections: [...current.connections, inbound],
    outputBindings: current.outputBindings.map((binding) =>
      bindingMatches(binding, boundSlot, phase)
        ? { ...binding, from: { nodeId: route.id, socketKey: ROUTE_OUTPUT_KEY } }
        : binding,
    ),
  }));
  store.commit(next, "structural");
  return route.id;
}

/**
 * Wires an output socket into a sink slot ({@link GraphOutputBinding}); any existing binding to
 * the same slot+phase is replaced (phase distinguishes behavior's two phase sinks; absent on render).
 */
export function addOutputBinding(store: Store, slot: GraphSlot, binding: GraphOutputBinding): void {
  const next = withGraph(store.getSource(), slot, (graph) => ({
    ...graph,
    outputBindings: [
      ...graph.outputBindings.filter(
        (existing) => !bindingMatches(existing, binding.slot, binding.phase),
      ),
      binding,
    ],
  }));
  store.commit(next, "structural");
}

/** Removes the binding into `boundSlot` (in `phase`, on behavior). No-op if none matches. */
export function removeOutputBinding(
  store: Store,
  slot: GraphSlot,
  boundSlot: string,
  phase?: "spawn" | "update",
): void {
  const next = withGraph(store.getSource(), slot, (graph) => ({
    ...graph,
    outputBindings: graph.outputBindings.filter(
      (binding) => !bindingMatches(binding, boundSlot, phase),
    ),
  }));
  store.commit(next, "structural");
}
