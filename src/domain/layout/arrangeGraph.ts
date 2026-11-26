/**
 * Auto-layout of one graph: columns left to right, sinks rightmost, cards on the grid, wires at
 * right angles. Pure: takes measured card sizes and returns the rearranged graph.
 *
 * A comment is laid out as a block (`commentTree.ts`): what it holds is laid out first, its frame
 * drawn round that, and the block takes part in the layout around it as one box, its wires passing
 * the ports on its edges (`levelProjection.ts`).
 *
 * Routes, positions and wires are rebuilt; comments are moved and resized round what they hold.
 * The topmost sink keeps its place so the graph does not jump out of view.
 */

import { isFakeNodeType, ROUTE_TYPE } from "../fakeNodes";
import { bindingSinkId } from "../graphEdges";
import type {
  EditorGraph,
  GraphComment,
  GraphConnection,
  GraphNode,
  GraphOutputBinding,
  GraphPosition,
  GraphSize,
  GraphSocketReference,
} from "../graphModel";
import type { GraphKind } from "../nodePalette";
import { isSink } from "../sinks";
import { type RouteGeometry, routeMetrics } from "./channelRouting";
import {
  type CommentBlock,
  commentFrame,
  type CommentLevel,
  commentTree,
  indexComments,
} from "./commentTree";
import type { LayoutEdge, LayoutItem, NodeMetrics } from "./layeredGraph";
import { layoutLevel } from "./levelLayout";
import { type LevelProjection, PortRoutes, projectLevel } from "./levelProjection";

export type { RouteGeometry } from "./channelRouting";
export type { NodeMetrics } from "./layeredGraph";

/** What the layout knows of the canvas: its grid and the size of what it places. */
export interface LayoutGeometry {
  /** The canvas grid every card and route snaps to. */
  readonly grid: number;
  /** A placed card's geometry; every non-route node of the graph is measured. */
  readonly measure: (nodeId: string) => NodeMetrics;
  readonly route: RouteGeometry;
  /** The height of `comment`'s header in a frame `width` wide. */
  readonly commentHeader: (comment: GraphComment, width: number) => number;
}

export interface ArrangeOptions extends LayoutGeometry {
  /** Mints a fresh document id (`route_<n>`, `conn_<n>`). */
  readonly mintId: (prefix: "route" | "conn") => string;
}

/** One authored edge (a connection, or a binding into a sink), with routes spliced out. */
interface AuthoredEdge extends LayoutEdge {
  /** Set when the edge is an output binding: the layout re-points its `from`. */
  readonly binding: GraphOutputBinding | undefined;
}

/** A laid-out level: positions relative to its own origin. */
interface Laid {
  readonly cards: Map<string, GraphPosition>;
  readonly routes: GraphNode[];
  readonly frames: Map<string, { position: GraphPosition; size: GraphSize }>;
}

/** A laid-out level and the wires it was laid out with. */
interface LaidLevel {
  readonly laid: Laid;
  readonly projection: LevelProjection<AuthoredEdge>;
}

/** A comment's block as one box of the level holding it. */
interface LaidBlock {
  readonly block: CommentBlock;
  readonly laid: Laid;
  readonly metrics: NodeMetrics;
  /** Whether it holds a sink and no signal leaves it: it keeps to the right as a sink would. */
  readonly sink: boolean;
}

export function arrangeGraph(
  graph: EditorGraph,
  kind: GraphKind,
  options: ArrangeOptions,
): EditorGraph {
  const { grid, route, measure, mintId, commentHeader } = options;
  const edges = authoredEdges(graph, kind);
  const cards = Object.values(graph.nodes).filter((node) => !isFakeNodeType(node.type));
  const metrics = new Map(cards.map((node) => [node.id, measure(node.id)]));
  const metricsOf = (card: string): NodeMetrics => {
    const found = metrics.get(card);
    if (found === undefined) {
      throw new Error(`Layout: no card "${card}"`);
    }
    return found;
  };
  const tree = commentTree(
    graph.comments,
    cards.map((node) => ({
      id: node.id,
      box: { ...node.position, ...sizeOf(metricsOf(node.id)) },
    })),
    edges.map((edge) => ({ from: edge.from.nodeId, to: edge.to.nodeId })),
  );
  const index = indexComments(tree);
  const ports = new PortRoutes(mintId);
  const holdsSink = (level: CommentLevel): boolean =>
    level.cards.some((card) => isSink(graph.nodes[card])) || level.blocks.some(holdsSink);

  const routeWires: GraphConnection[] = [];
  const portWires: GraphConnection[] = [];
  /** What finally feeds each authored edge's input. */
  const feeds = new Map<AuthoredEdge, GraphSocketReference>();

  /** Lays out what `level` holds; `block` is the comment it is, `undefined` for the graph. */
  const layOut = (level: CommentLevel, block: CommentBlock | undefined): LaidLevel => {
    const children = level.blocks.map(layOutBlock);
    const projection = projectLevel(level, block, edges, index, ports);
    // A level some signal leaves keeps only its exit ports to the right, otherwise its sinks.
    const pin = (sink: boolean): LayoutItem["pin"] =>
      sink && projection.exitPorts.size === 0 ? "sink" : undefined;
    const portMetrics = routeMetrics(route, grid);
    const items: LayoutItem[] = [
      ...level.cards.map((card) => ({
        id: card,
        metrics: metricsOf(card),
        y: graph.nodes[card]?.position.y ?? 0,
        pin: pin(isSink(graph.nodes[card])),
      })),
      ...children.map((child) => ({
        id: child.block.comment.id,
        metrics: child.metrics,
        y: child.block.comment.position.y,
        pin: pin(child.sink),
      })),
      ...[...projection.entryPorts.keys()].map((id) => ({
        id,
        metrics: portMetrics,
        y: 0,
        pin: "inlet" as const,
      })),
      ...[...projection.exitPorts.keys()].map((id) => ({
        id,
        metrics: portMetrics,
        y: 0,
        pin: "sink" as const,
      })),
    ];
    const layout = layoutLevel(items, projection.edges, {
      grid,
      route,
      mintId,
      sourceSocket: projection.sourceSocket,
    });
    routeWires.push(...layout.routeWires);
    for (const wire of projection.edges) {
      const feed = layout.feeds.get(wire);
      if (feed === undefined) {
        throw new Error("Layout: a wire was left unrouted");
      }
      const authored = projection.authored.get(wire);
      if (authored === undefined) {
        portWires.push({ id: mintId("conn"), from: feed, to: projection.targetSocket(wire.to) });
      }
      for (const edge of authored ?? []) {
        feeds.set(edge, feed);
      }
    }

    const positionOf = (id: string): GraphPosition => {
      const position = layout.positions.get(id);
      if (position === undefined) {
        throw new Error(`Layout: "${id}" was not placed`);
      }
      return position;
    };
    const laid: Laid = { cards: new Map(), routes: [...layout.routes], frames: new Map() };
    for (const card of level.cards) {
      laid.cards.set(card, positionOf(card));
    }
    for (const id of [...projection.entryPorts.keys(), ...projection.exitPorts.keys()]) {
      laid.routes.push({ id, type: ROUTE_TYPE, parameters: {}, position: positionOf(id) });
    }
    for (const child of children) {
      merge(laid, child.laid, positionOf(child.block.comment.id));
    }
    return { laid, projection };
  };

  /** Lays out a comment's block inside its frame, which is placed at the origin. */
  const layOutBlock = (block: CommentBlock): LaidBlock => {
    const { laid, projection } = layOut(block, block);
    const boxes = [
      ...[...laid.cards].map(([card, position]) => ({ position, ...sizeOf(metricsOf(card)) })),
      ...laid.routes.map((node) => ({ position: node.position, width: route.width, height: grid })),
      ...[...laid.frames.values()].map((frame) => ({ position: frame.position, ...frame.size })),
    ];
    const bounds = {
      left: Math.min(...boxes.map((box) => box.position.x)),
      top: Math.min(...boxes.map((box) => box.position.y)),
      right: Math.max(...boxes.map((box) => box.position.x + box.width)),
      bottom: Math.max(...boxes.map((box) => box.position.y + box.height)),
    };
    // Its ports stand on its edges; its header's height depends on its width, not the other way.
    const flush = { left: projection.entryPorts.size > 0, right: projection.exitPorts.size > 0 };
    const width = commentFrame(bounds, 0, grid, flush).size.width;
    const frame = commentFrame(bounds, commentHeader(block.comment, width), grid, flush);
    const placed: Laid = { cards: new Map(), routes: [], frames: new Map() };
    merge(placed, laid, { x: -frame.position.x, y: -frame.position.y });
    placed.frames.set(block.comment.id, { position: { x: 0, y: 0 }, size: frame.size });
    const portRows = (portRoutes: ReadonlyMap<string, string>): Record<string, number> =>
      Object.fromEntries(
        placed.routes
          .filter((node) => portRoutes.has(node.id))
          .map((node) => [portRoutes.get(node.id), node.position.y + route.row]),
      );
    return {
      block,
      laid: placed,
      metrics: {
        ...frame.size,
        inputRows: portRows(projection.entryPorts),
        outputRows: portRows(projection.exitPorts),
      },
      sink: holdsSink(block) && projection.exitPorts.size === 0,
    };
  };

  const { laid } = layOut(tree, undefined);

  // Shift everything so the topmost sink keeps its place.
  const anchor = topmostSink(graph);
  const anchorAt = anchor === undefined ? undefined : laid.cards.get(anchor.id);
  const shift =
    anchor !== undefined && anchorAt !== undefined
      ? { x: anchor.position.x - anchorAt.x, y: anchor.position.y - anchorAt.y }
      : { x: 0, y: 0 };
  const nodes: Record<string, GraphNode> = {};
  for (const node of cards) {
    const position = laid.cards.get(node.id);
    if (position !== undefined) {
      nodes[node.id] = { ...node, position: offset(position, shift) };
    }
  }
  for (const node of laid.routes) {
    nodes[node.id] = { ...node, position: offset(node.position, shift) };
  }
  const comments = graph.comments.flatMap((comment) => {
    const frame = laid.frames.get(comment.id);
    return frame === undefined
      ? []
      : [{ ...comment, position: offset(frame.position, shift), size: frame.size }];
  });

  // Authored edges keep their document order (it reaches the compiled graph), route wires follow.
  const connections: GraphConnection[] = [];
  const outputBindings: GraphOutputBinding[] = [];
  for (const edge of edges) {
    const from = feeds.get(edge);
    if (from === undefined) {
      throw new Error("Layout: an edge was left unrouted");
    }
    if (edge.binding !== undefined) {
      outputBindings.push({ ...edge.binding, from });
    } else {
      connections.push({ id: mintId("conn"), from, to: edge.to });
    }
  }
  connections.push(...routeWires, ...portWires);
  return { ...graph, nodes, connections, outputBindings, comments };
}

/** Every connection and output binding, each traced back through routes to its real source. */
function authoredEdges(graph: EditorGraph, kind: GraphKind): AuthoredEdge[] {
  const isRoute = (nodeId: string): boolean => graph.nodes[nodeId]?.type === ROUTE_TYPE;
  const routeFeed = new Map<string, GraphSocketReference>();
  for (const connection of graph.connections) {
    if (isRoute(connection.to.nodeId)) {
      routeFeed.set(connection.to.nodeId, connection.from);
    }
  }
  const origin = (reference: GraphSocketReference): GraphSocketReference | undefined => {
    let current: GraphSocketReference | undefined = reference;
    const seen = new Set<string>();
    while (current !== undefined && isRoute(current.nodeId)) {
      if (seen.has(current.nodeId)) {
        return undefined;
      }
      seen.add(current.nodeId);
      current = routeFeed.get(current.nodeId);
    }
    return current;
  };
  const edges: AuthoredEdge[] = [];
  for (const connection of graph.connections) {
    const from = origin(connection.from);
    if (from !== undefined && !isRoute(connection.to.nodeId)) {
      edges.push({ from, to: connection.to, binding: undefined });
    }
  }
  for (const binding of graph.outputBindings) {
    const from = origin(binding.from);
    if (from !== undefined) {
      edges.push({
        from,
        to: { nodeId: bindingSinkId(kind, binding), socketKey: binding.slot },
        binding,
      });
    }
  }
  return edges.filter((edge) => edge.from.nodeId in graph.nodes && edge.to.nodeId in graph.nodes);
}

function topmostSink(graph: EditorGraph): GraphNode | undefined {
  return Object.values(graph.nodes)
    .filter((node) => isSink(node))
    .sort((first, second) => first.position.y - second.position.y)[0];
}

function sizeOf(metrics: NodeMetrics): GraphSize {
  return { width: metrics.width, height: metrics.height };
}

function offset(position: GraphPosition, by: GraphPosition): GraphPosition {
  return { x: position.x + by.x, y: position.y + by.y };
}

/** Adds `inner`, placed at `at`, to `outer`. */
function merge(outer: Laid, inner: Laid, at: GraphPosition): void {
  for (const [card, position] of inner.cards) {
    outer.cards.set(card, offset(position, at));
  }
  for (const node of inner.routes) {
    outer.routes.push({ ...node, position: offset(node.position, at) });
  }
  for (const [id, frame] of inner.frames) {
    outer.frames.set(id, { position: offset(frame.position, at), size: frame.size });
  }
}
