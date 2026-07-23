/**
 * Edge geometry for hit-testing: rebuilds each drawn wire's polyline (the same elbow shape the
 * {@link WireRenderer} draws) tagged with how to address it for removal, and finds the edge nearest
 * a point. Drives the Alt-knife wire cut and route insertion. Pure - socket centres come in through
 * the injected {@link SocketCenter}, so it never touches the node/route views.
 */

import type { EditorGraph } from "../../domain/graphModel";
import { distanceToSegment } from "../primitives/geometry";
import type { GraphPoint } from "./graphViewport";
import type { SocketSide } from "./nodeView";
import { wirePoints, type SinkNodeId, type SocketCenter } from "./wireRenderer";

/** How a drawn wire is addressed for removal / route-insertion - a connection or a sink binding. */
export type EdgeDescriptor =
  | { readonly kind: "connection"; readonly id: string }
  | {
      readonly kind: "binding";
      readonly slot: string;
      readonly phase: "spawn" | "update" | undefined;
    };

/** One drawn edge: its wire polyline (graph coords) and how to address it for removal. */
export interface GraphEdge {
  readonly descriptor: EdgeDescriptor;
  readonly points: readonly [GraphPoint, GraphPoint, GraphPoint, GraphPoint];
}

/** Every drawn edge (connections + sink bindings) with its wire polyline in graph coordinates. */
export function collectEdges(
  graph: EditorGraph,
  socketCenter: SocketCenter,
  sinkNodeId: SinkNodeId,
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const connection of graph.connections) {
    const from = socketCenter(connection.from.nodeId, connection.from.socketKey, "output");
    const to = socketCenter(connection.to.nodeId, connection.to.socketKey, "input");
    if (from !== undefined && to !== undefined) {
      edges.push({
        descriptor: { kind: "connection", id: connection.id },
        points: wirePoints(from, to),
      });
    }
  }
  for (const binding of graph.outputBindings) {
    const sink = sinkNodeId(binding);
    const from = socketCenter(binding.from.nodeId, binding.from.socketKey, "output");
    const to = socketCenter(sink, binding.slot, "input");
    if (from !== undefined && to !== undefined) {
      edges.push({
        descriptor: { kind: "binding", slot: binding.slot, phase: binding.phase },
        points: wirePoints(from, to),
      });
    }
  }
  return edges;
}

/**
 * The connected ports of every node, keyed by node id, each a set of `${side}:${socketKey}`. A port
 * is connected if it is an endpoint of a connection or an output binding (the sink side of a binding
 * is its `slot` input). The canvas paints those dots filled.
 */
export function computeSocketFills(
  graph: EditorGraph,
  sinkNodeId: SinkNodeId,
): Map<string, Set<string>> {
  const fills = new Map<string, Set<string>>();
  const add = (nodeId: string, side: SocketSide, key: string): void => {
    let set = fills.get(nodeId);
    if (set === undefined) {
      set = new Set();
      fills.set(nodeId, set);
    }
    set.add(`${side}:${key}`);
  };
  for (const connection of graph.connections) {
    add(connection.from.nodeId, "output", connection.from.socketKey);
    add(connection.to.nodeId, "input", connection.to.socketKey);
  }
  for (const binding of graph.outputBindings) {
    add(binding.from.nodeId, "output", binding.from.socketKey);
    add(sinkNodeId(binding), "input", binding.slot);
  }
  return fills;
}

/** The edge whose polyline passes nearest `point`, within `tolerance` (graph units), if any. */
export function edgeNearPoint(
  edges: readonly GraphEdge[],
  point: GraphPoint,
  tolerance: number,
): GraphEdge | undefined {
  let best: GraphEdge | undefined;
  let bestDistance = tolerance;
  for (const edge of edges) {
    const [first, second, third, fourth] = edge.points;
    const segments: readonly [GraphPoint, GraphPoint][] = [
      [first, second],
      [second, third],
      [third, fourth],
    ];
    for (const [start, end] of segments) {
      const distance = distanceToSegment(point, start, end);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = edge;
      }
    }
  }
  return best;
}
