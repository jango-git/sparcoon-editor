/**
 * Auto-layout of one authored graph: a tidy left-to-right arrangement with the sinks in the
 * rightmost column, every card on the grid, no card over another, and every wire drawn at right
 * angles - level, or turning on a vertical lane with routes where a card's own stubs cannot reach
 * it. Pure: it gets each card's measured size and socket rows, and returns the rearranged graph.
 *
 * What compiles is unchanged (routes are spliced out at serialize); node positions, routes and
 * the wires through them are rebuilt, and comments are dropped - their boxes would no longer frame
 * anything. The topmost sink stays where it was, so the graph does not jump away from the view.
 *
 * Stages: {@link buildLayeredGraph} (columns, signals, placeholder rows), {@link placeRows}
 * (heights), {@link planColumns} (column x and per-channel lanes), then the wiring below.
 */

import { isFakeNodeType, ROUTE_INPUT_KEY, ROUTE_OUTPUT_KEY, ROUTE_TYPE } from "../fakeNodes";
import type {
  EditorGraph,
  GraphConnection,
  GraphNode,
  GraphOutputBinding,
  GraphSocketReference,
} from "../graphModel";
import type { GraphKind } from "../nodePalette";
import { isSink } from "../sinks";
import { planColumns, type RouteGeometry } from "./channelRouting";
import {
  buildLayeredGraph,
  type LayoutEdge,
  type LayoutLink,
  type LayoutSignal,
  type NodeMetrics,
} from "./layeredGraph";
import { placeRows, targetRow } from "./rowPlacement";

export type { RouteGeometry } from "./channelRouting";
export type { NodeMetrics } from "./layeredGraph";

/** What the layout knows of the canvas: its grid and the size of what it places. */
export interface LayoutGeometry {
  /** The canvas grid every card and route snaps to. */
  readonly grid: number;
  /** A placed card's geometry; every non-route node of the graph is measured. */
  readonly measure: (nodeId: string) => NodeMetrics;
  readonly route: RouteGeometry;
}

export interface ArrangeOptions extends LayoutGeometry {
  /** Mints a fresh document id (`route_<n>`, `conn_<n>`). */
  readonly mintId: (prefix: "route" | "conn") => string;
}

export function arrangeGraph(
  graph: EditorGraph,
  kind: GraphKind,
  options: ArrangeOptions,
): EditorGraph {
  const { grid, route, mintId } = options;
  const anchor = topmostSink(graph);
  const layered = buildLayeredGraph(graph, kind, options.measure, grid);
  placeRows(layered, grid);
  const { columnX, channels } = planColumns(layered, grid, route);

  // Real cards at their column and row, all shifted so the topmost sink keeps its place.
  const placed = new Map<string, { readonly x: number; readonly y: number }>();
  for (const layer of layered.layers) {
    for (const entity of layer) {
      if (entity.signal === undefined) {
        placed.set(entity.id, { x: columnX[entity.layer] ?? 0, y: entity.y });
      }
    }
  }
  const anchorAt = anchor === undefined ? undefined : placed.get(anchor.id);
  const shiftX =
    anchor !== undefined && anchorAt !== undefined ? anchor.position.x - anchorAt.x : 0;
  const shiftY =
    anchor !== undefined && anchorAt !== undefined ? anchor.position.y - anchorAt.y : 0;

  const nodes: Record<string, GraphNode> = {};
  for (const node of Object.values(graph.nodes)) {
    const at = placed.get(node.id);
    if (!isFakeNodeType(node.type) && at !== undefined) {
      nodes[node.id] = { ...node, position: { x: at.x + shiftX, y: at.y + shiftY } };
    }
  }
  const routeWires: GraphConnection[] = [];
  /** What now feeds each authored edge's input: its source, or the last route on its way. */
  const feeds = new Map<LayoutEdge, GraphSocketReference>();
  const addRoute = (x: number, row: number, from: GraphSocketReference): GraphSocketReference => {
    const id = mintId("route");
    const position = { x: x + shiftX, y: row - route.row + shiftY };
    nodes[id] = { id, type: ROUTE_TYPE, parameters: {}, position };
    routeWires.push({ id: mintId("conn"), from, to: { nodeId: id, socketKey: ROUTE_INPUT_KEY } });
    return { nodeId: id, socketKey: ROUTE_OUTPUT_KEY };
  };
  const wire = (link: LayoutLink, from: GraphSocketReference): void => {
    if (link.edge !== undefined) {
      feeds.set(link.edge, from);
    }
  };

  // Left to right, so each channel knows what carries every signal into it.
  const carrier = new Map<LayoutSignal, GraphSocketReference>(
    layered.signals.map((signal) => [
      signal,
      { nodeId: signal.source.id, socketKey: signal.socketKey },
    ]),
  );
  for (let layer = channels.length - 1; layer >= 1; layer--) {
    for (const net of channels[layer]?.nets ?? []) {
      const incoming = carrier.get(net.signal);
      if (incoming === undefined) {
        continue;
      }
      const lane = net.lane;
      const feed =
        lane !== undefined && net.needsLeadRoute
          ? addRoute(lane - grid - route.width, net.sourceRow, incoming)
          : incoming;
      for (const link of net.links) {
        const onward =
          lane !== undefined && net.trailRoutes.has(link)
            ? addRoute(lane + grid, targetRow(link), feed)
            : feed;
        if (link.to.entity.signal === undefined) {
          wire(link, onward);
        } else {
          carrier.set(net.signal, onward);
        }
      }
    }
  }
  // A cycle's back edge is the one link not between adjacent layers: wired straight.
  for (const link of layered.links) {
    if (link.from.entity.layer - link.to.entity.layer !== 1) {
      wire(link, { nodeId: link.signal.source.id, socketKey: link.signal.socketKey });
    }
  }

  // Authored edges keep their document order (it reaches the compiled graph), route wires follow.
  const connections: GraphConnection[] = [];
  const outputBindings: GraphOutputBinding[] = [];
  for (const edge of layered.edges) {
    const from = feeds.get(edge) ?? edge.from;
    if (edge.binding !== undefined) {
      outputBindings.push({ ...edge.binding, from });
    } else {
      connections.push({ id: mintId("conn"), from, to: edge.to });
    }
  }
  connections.push(...routeWires);
  return { ...graph, nodes, connections, outputBindings, comments: [] };
}

function topmostSink(graph: EditorGraph): GraphNode | undefined {
  return Object.values(graph.nodes)
    .filter((node) => isSink(node))
    .sort((first, second) => first.position.y - second.position.y)[0];
}
