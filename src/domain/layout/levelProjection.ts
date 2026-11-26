/**
 * The wires of one level of the comment tree (`commentTree.ts`). Each authored edge is seen at a
 * level as the stretch between the two items standing for its ends there: a card itself, or the
 * block of the comment holding it. An end outside the level - the level being a comment's block -
 * is the block's own port: a route on its left edge for a signal entering it, on its right edge for
 * one leaving it. A signal passes one port per block and side, however many cards it feeds.
 */

import { ROUTE_INPUT_KEY, ROUTE_OUTPUT_KEY } from "../fakeNodes";
import type { GraphSocketReference } from "../graphModel";
import type { CommentBlock, CommentIndex, CommentLevel } from "./commentTree";
import type { LayoutEdge } from "./layeredGraph";

/** The routes signals pass entering and leaving blocks, one per block, side and signal. */
export class PortRoutes {
  private readonly ids = new Map<string, string>();

  constructor(private readonly mintId: (prefix: "route") => string) {}

  public entry(block: CommentBlock, signal: string): string {
    return this.route(block, "entry", signal);
  }

  public exit(block: CommentBlock, signal: string): string {
    return this.route(block, "exit", signal);
  }

  private route(block: CommentBlock, side: string, signal: string): string {
    const key = `${block.comment.id}\u0000${side}\u0000${signal}`;
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.mintId("route");
      this.ids.set(key, id);
    }
    return id;
  }
}

export interface LevelProjection<E extends LayoutEdge> {
  /** The level's wires between its items: cards, blocks (sockets keyed by signal) and ports. */
  readonly edges: readonly LayoutEdge[];
  /** The authored edges each wire ends, for the wires into a card of the level. */
  readonly authored: ReadonlyMap<LayoutEdge, readonly E[]>;
  /** The level's own ports, each route by the signal it passes. */
  readonly entryPorts: ReadonlyMap<string, string>;
  readonly exitPorts: ReadonlyMap<string, string>;
  /** The document socket a wire leaves from for an item's output. */
  readonly sourceSocket: (source: GraphSocketReference) => GraphSocketReference;
  /** The document socket a wire enters for an item's input. */
  readonly targetSocket: (target: GraphSocketReference) => GraphSocketReference;
}

/** A signal's key: the socket it leaves from. */
export function signalOf(edge: LayoutEdge): string {
  return `${edge.from.nodeId}\u0000${edge.from.socketKey}`;
}

/** `level`'s wires; `block` is the comment it is, `undefined` for the whole graph. */
export function projectLevel<E extends LayoutEdge>(
  level: CommentLevel,
  block: CommentBlock | undefined,
  authoredEdges: readonly E[],
  index: CommentIndex,
  ports: PortRoutes,
): LevelProjection<E> {
  const ownBlock = (): CommentBlock => {
    if (block === undefined) {
      throw new Error("Layout: a wire leaves the graph");
    }
    return block;
  };
  const edges = new Map<string, LayoutEdge>();
  const authored = new Map<LayoutEdge, E[]>();
  const entryPorts = new Map<string, string>();
  const exitPorts = new Map<string, string>();
  for (const edge of authoredEdges) {
    const signal = signalOf(edge);
    const from = index.unitAt(level, edge.from.nodeId);
    const to = index.unitAt(level, edge.to.nodeId);
    if ((from === undefined && to === undefined) || (from === to && typeof from !== "string")) {
      continue;
    }
    let source: GraphSocketReference;
    if (from === undefined) {
      source = { nodeId: ports.entry(ownBlock(), signal), socketKey: ROUTE_OUTPUT_KEY };
      entryPorts.set(source.nodeId, signal);
    } else {
      source =
        typeof from === "string" ? edge.from : { nodeId: from.comment.id, socketKey: signal };
    }
    let target: GraphSocketReference;
    if (to === undefined) {
      target = { nodeId: ports.exit(ownBlock(), signal), socketKey: ROUTE_INPUT_KEY };
      exitPorts.set(target.nodeId, signal);
    } else {
      target = typeof to === "string" ? edge.to : { nodeId: to.comment.id, socketKey: signal };
    }
    const key = [source.nodeId, source.socketKey, target.nodeId, target.socketKey].join("\u0000");
    let wire = edges.get(key);
    if (wire === undefined) {
      wire = { from: source, to: target };
      edges.set(key, wire);
    }
    if (typeof to === "string") {
      authored.set(wire, [...(authored.get(wire) ?? []), edge]);
    }
  }

  const children = new Map(level.blocks.map((child) => [child.comment.id, child]));
  return {
    edges: [...edges.values()],
    authored,
    entryPorts,
    exitPorts,
    sourceSocket: (source): GraphSocketReference => {
      const child = children.get(source.nodeId);
      return child === undefined
        ? source
        : { nodeId: ports.exit(child, source.socketKey), socketKey: ROUTE_OUTPUT_KEY };
    },
    targetSocket: (target): GraphSocketReference => {
      const child = children.get(target.nodeId);
      return child === undefined
        ? target
        : { nodeId: ports.entry(child, target.socketKey), socketKey: ROUTE_INPUT_KEY };
    },
  };
}
