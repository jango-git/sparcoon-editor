/**
 * Layered view for the auto-layout. Every item (a card, a comment's block or a block's port) sits
 * in a column (layer) by its longest path to the sinks, which take layer 0, the rightmost column.
 * Every wire is a signal (one source socket with all the inputs it feeds) occupying one
 * placeholder row (a dummy) in each column it crosses, so a wire never runs through an item.
 *
 * Entities carry a mutable `y` (top edge), written by row placement and read by channel routing.
 */

import type { GraphSocketReference } from "../graphModel";

/** A card's measured geometry: its box and each socket dot's centre height from its top edge. */
export interface NodeMetrics {
  readonly width: number;
  readonly height: number;
  readonly inputRows: Readonly<Record<string, number>>;
  readonly outputRows: Readonly<Record<string, number>>;
}

/** One box the layout places, with its geometry. */
export interface LayoutItem {
  readonly id: string;
  readonly metrics: NodeMetrics;
  /** Top edge before the layout: it orders the sinks. */
  readonly y: number;
  /** A fixed layer: `"sink"` the rightmost, `"inlet"` left of every other item. */
  readonly pin: "sink" | "inlet" | undefined;
}

/** A real node or a signal's placeholder row in one layer. */
export interface LayoutEntity {
  readonly id: string;
  readonly layer: number;
  /** Card width (0 for a dummy, which takes no column width). */
  readonly width: number;
  /** Height rounded up to whole grid cells, so stacking keeps every card on the grid. */
  readonly height: number;
  /** The signal a dummy carries; `undefined` for a real node. */
  readonly signal: LayoutSignal | undefined;
  /** How strongly the row placement pulls this entity to where its wires want it. */
  readonly weight: number;
  /** Top edge, graph units: written by the row placement. */
  y: number;
  readonly inputRow: (socketKey: string) => number;
  readonly outputRow: (socketKey: string) => number;
}

/** A wire between two items' sockets. */
export interface LayoutEdge {
  readonly from: GraphSocketReference;
  readonly to: GraphSocketReference;
}

/** A source socket and every input it feeds. */
export interface LayoutSignal {
  readonly key: string;
  readonly source: LayoutEntity;
  readonly socketKey: string;
  readonly edges: readonly LayoutEdge[];
}

export interface LayoutPort {
  readonly entity: LayoutEntity;
  readonly socketKey: string;
}

/** A signal's hop between two adjacent layers: into a target input, or on to its next dummy. */
export interface LayoutLink {
  readonly signal: LayoutSignal;
  readonly from: LayoutPort;
  readonly to: LayoutPort;
  /** The authored edge this hop ends; `undefined` on a hop into a dummy. */
  readonly edge: LayoutEdge | undefined;
}

export interface LayeredGraph {
  /** Entities by layer, index 0 the sinks' (rightmost) column. */
  readonly layers: readonly LayoutEntity[][];
  /** Every edge, in the order given. */
  readonly edges: readonly LayoutEdge[];
  readonly signals: readonly LayoutSignal[];
  readonly links: readonly LayoutLink[];
  readonly outgoing: ReadonlyMap<LayoutEntity, readonly LayoutLink[]>;
  readonly incoming: ReadonlyMap<LayoutEntity, readonly LayoutLink[]>;
}

/** Row placement pulls a real card harder than a wire's placeholder. */
const NODE_WEIGHT = 1;
const DUMMY_WEIGHT = 0.6;

export function buildLayeredGraph(
  items: readonly LayoutItem[],
  edges: readonly LayoutEdge[],
  grid: number,
): LayeredGraph {
  const byId = new Map(items.map((item) => [item.id, item]));
  const targets = new Map<string, string[]>(items.map((item) => [item.id, []]));
  for (const edge of edges) {
    targets.get(edge.from.nodeId)?.push(edge.to.nodeId);
  }
  const pathLayer = longestPathLayers(
    items.map((item) => item.id),
    (id) => targets.get(id) ?? [],
    (id) => byId.get(id)?.pin === "sink",
  );
  const inletLayer =
    1 +
    Math.max(0, ...items.filter((item) => item.pin !== "inlet").map((item) => pathLayer(item.id)));
  const layerOf = (id: string): number =>
    byId.get(id)?.pin === "inlet" ? inletLayer : pathLayer(id);

  const entities = new Map<string, LayoutEntity>();
  for (const item of items) {
    const { metrics } = item;
    entities.set(item.id, {
      id: item.id,
      layer: layerOf(item.id),
      width: metrics.width,
      height: Math.ceil(metrics.height / grid) * grid,
      signal: undefined,
      weight: NODE_WEIGHT,
      y: item.y,
      inputRow: (socketKey) => Math.round(metrics.inputRows[socketKey] ?? grid * 1.5),
      outputRow: (socketKey) => Math.round(metrics.outputRows[socketKey] ?? grid * 1.5),
    });
  }
  const entityOf = (nodeId: string): LayoutEntity => {
    const entity = entities.get(nodeId);
    if (entity === undefined) {
      throw new Error(`Layout: no item "${nodeId}"`);
    }
    return entity;
  };

  const bySource = new Map<string, LayoutEdge[]>();
  for (const edge of edges) {
    const key = `${edge.from.nodeId}\u0000${edge.from.socketKey}`;
    const group = bySource.get(key);
    if (group === undefined) {
      bySource.set(key, [edge]);
    } else {
      group.push(edge);
    }
  }

  const signals: LayoutSignal[] = [];
  const links: LayoutLink[] = [];
  const dummies: LayoutEntity[] = [];
  for (const [key, signalEdges] of bySource) {
    const first = signalEdges[0];
    if (first === undefined) {
      continue;
    }
    const signal: LayoutSignal = {
      key,
      source: entityOf(first.from.nodeId),
      socketKey: first.from.socketKey,
      edges: signalEdges,
    };
    signals.push(signal);
    // Out of each layer the signal leaves on one port: its source, then a dummy per crossed layer.
    const carriers = new Map<number, LayoutPort>([
      [signal.source.layer, { entity: signal.source, socketKey: signal.socketKey }],
    ]);
    const nearest = Math.min(...signalEdges.map((edge) => entityOf(edge.to.nodeId).layer));
    for (let layer = signal.source.layer - 1; layer > nearest; layer--) {
      const dummy = dummyEntity(`${key}\u0000${layer}`, layer, signal, grid);
      dummies.push(dummy);
      const from = carriers.get(layer + 1);
      if (from !== undefined) {
        links.push({ signal, from, to: { entity: dummy, socketKey: "" }, edge: undefined });
      }
      carriers.set(layer, { entity: dummy, socketKey: "" });
    }
    for (const edge of signalEdges) {
      const target = entityOf(edge.to.nodeId);
      // Layers strictly fall along an edge (a cycle is the only exception: wire it from the source)
      const from = carriers.get(target.layer + 1) ?? {
        entity: signal.source,
        socketKey: signal.socketKey,
      };
      links.push({ signal, from, to: { entity: target, socketKey: edge.to.socketKey }, edge });
    }
  }

  const all = [...entities.values(), ...dummies];
  const layerCount = Math.max(0, ...all.map((entity) => entity.layer)) + 1;
  const layers: LayoutEntity[][] = Array.from({ length: layerCount }, () => []);
  for (const entity of all) {
    layers[entity.layer]?.push(entity);
  }
  const outgoing = new Map<LayoutEntity, LayoutLink[]>(all.map((entity) => [entity, []]));
  const incoming = new Map<LayoutEntity, LayoutLink[]>(all.map((entity) => [entity, []]));
  for (const link of links) {
    outgoing.get(link.from.entity)?.push(link);
    incoming.get(link.to.entity)?.push(link);
  }
  return { layers, edges, signals, links, outgoing, incoming };
}

/** Sinks take layer 0; any other node one more than its farthest-out target (1 with none). */
function longestPathLayers(
  ids: readonly string[],
  targetsOf: (id: string) => readonly string[],
  isSinkNode: (id: string) => boolean,
): (id: string) => number {
  const layers = new Map<string, number>();
  const visiting = new Set<string>();
  const layerOf = (id: string): number => {
    const known = layers.get(id);
    if (known !== undefined) {
      return known;
    }
    if (isSinkNode(id)) {
      layers.set(id, 0);
      return 0;
    }
    if (visiting.has(id)) {
      return 1; // a cycle: break it here
    }
    visiting.add(id);
    const targets = targetsOf(id);
    const layer = targets.length > 0 ? 1 + Math.max(...targets.map(layerOf)) : 1;
    visiting.delete(id);
    layers.set(id, layer);
    return layer;
  };
  ids.forEach(layerOf);
  return layerOf;
}

/** A signal's one-cell placeholder row in a layer it crosses. */
function dummyEntity(id: string, layer: number, signal: LayoutSignal, grid: number): LayoutEntity {
  return {
    id,
    layer,
    width: 0,
    height: grid,
    signal,
    weight: DUMMY_WEIGHT,
    y: 0,
    inputRow: () => grid / 2,
    outputRow: () => grid / 2,
  };
}
