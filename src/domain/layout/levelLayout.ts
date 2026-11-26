/**
 * One level of the auto-layout: items (cards, comments' blocks, a block's ports) in columns left to
 * right, sinks rightmost, on the grid, with the routes their wires need to stay at right angles.
 * Positions are relative: the caller places the level.
 */

import { ROUTE_INPUT_KEY, ROUTE_OUTPUT_KEY, ROUTE_TYPE } from "../fakeNodes";
import type {
  GraphConnection,
  GraphNode,
  GraphPosition,
  GraphSocketReference,
} from "../graphModel";
import { planColumns, type RouteGeometry } from "./channelRouting";
import {
  buildLayeredGraph,
  type LayoutEdge,
  type LayoutItem,
  type LayoutLink,
  type LayoutSignal,
} from "./layeredGraph";
import { placeRows, targetRow } from "./rowPlacement";

export interface LevelOptions {
  readonly grid: number;
  readonly route: RouteGeometry;
  /** Mints a fresh document id (`route_<n>`, `conn_<n>`). */
  readonly mintId: (prefix: "route" | "conn") => string;
  /** The document socket a wire leaves from for an item's output socket. */
  readonly sourceSocket: (source: GraphSocketReference) => GraphSocketReference;
}

export interface LevelLayout {
  /** Each item's top-left. */
  readonly positions: ReadonlyMap<string, GraphPosition>;
  /** The routes laid for wires that turn. */
  readonly routes: readonly GraphNode[];
  /** The wires into those routes. */
  readonly routeWires: readonly GraphConnection[];
  /** What feeds each edge's target: its source's socket, or the last route on its way. */
  readonly feeds: ReadonlyMap<LayoutEdge, GraphSocketReference>;
}

export function layoutLevel(
  items: readonly LayoutItem[],
  edges: readonly LayoutEdge[],
  options: LevelOptions,
): LevelLayout {
  const { grid, route, mintId, sourceSocket } = options;
  const layered = buildLayeredGraph(items, edges, grid);
  placeRows(layered, grid);
  const { columnX, channels } = planColumns(layered, grid, route);

  const positions = new Map<string, GraphPosition>();
  for (const layer of layered.layers) {
    for (const entity of layer) {
      if (entity.signal === undefined) {
        positions.set(entity.id, { x: columnX[entity.layer] ?? 0, y: entity.y });
      }
    }
  }
  const routes: GraphNode[] = [];
  const routeWires: GraphConnection[] = [];
  const feeds = new Map<LayoutEdge, GraphSocketReference>();
  const addRoute = (x: number, row: number, from: GraphSocketReference): GraphSocketReference => {
    const id = mintId("route");
    routes.push({ id, type: ROUTE_TYPE, parameters: {}, position: { x, y: row - route.row } });
    routeWires.push({ id: mintId("conn"), from, to: { nodeId: id, socketKey: ROUTE_INPUT_KEY } });
    return { nodeId: id, socketKey: ROUTE_OUTPUT_KEY };
  };
  const wire = (link: LayoutLink, from: GraphSocketReference): void => {
    if (link.edge !== undefined) {
      feeds.set(link.edge, from);
    }
  };
  const signalSource = (signal: LayoutSignal): GraphSocketReference =>
    sourceSocket({ nodeId: signal.source.id, socketKey: signal.socketKey });

  // Left to right, so each channel knows what carries every signal into it.
  const carrier = new Map<LayoutSignal, GraphSocketReference>(
    layered.signals.map((signal) => [signal, signalSource(signal)]),
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
      wire(link, signalSource(link.signal));
    }
  }
  return { positions, routes, routeWires, feeds };
}
