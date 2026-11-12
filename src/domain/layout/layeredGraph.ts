/**
 * The layered view of an authored graph the auto-layout works on (see `arrangeGraph.ts`): every
 * real node in a column (a layer) by its longest path to the sinks, which take layer 0 (the
 * rightmost column); every wire as a signal - one source socket with all the inputs it feeds -
 * that occupies one placeholder row (a dummy) in each column it crosses, so a wire never runs
 * through a card. Routes are spliced out: the layout rebuilds them.
 *
 * Entities carry a mutable `y` (their top edge): the row placement writes it, the channel routing
 * and the emitter read it. Nothing outside the layout sees these objects.
 */

import { isFakeNodeType, ROUTE_TYPE } from "../fakeNodes";
import { bindingSinkId } from "../graphEdges";
import type { EditorGraph, GraphOutputBinding, GraphSocketReference } from "../graphModel";
import type { GraphKind } from "../nodePalette";
import { isSink } from "../sinks";

/** A card's measured geometry: its box and each socket dot's centre height from its top edge. */
export interface NodeMetrics {
  readonly width: number;
  readonly height: number;
  readonly inputRows: Readonly<Record<string, number>>;
  readonly outputRows: Readonly<Record<string, number>>;
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

/** One authored edge (a connection, or a binding into a sink), with routes spliced out. */
export interface LayoutEdge {
  readonly from: GraphSocketReference;
  readonly to: GraphSocketReference;
  /** Set when the edge is an output binding: the layout re-points its `from`. */
  readonly binding: GraphOutputBinding | undefined;
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
  /** Every authored edge, in document order (connections, then bindings). */
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
  graph: EditorGraph,
  kind: GraphKind,
  measure: (nodeId: string) => NodeMetrics,
  grid: number,
): LayeredGraph {
  const nodes = Object.values(graph.nodes).filter((node) => !isFakeNodeType(node.type));
  const edges = authoredEdges(graph, kind).filter(
    (edge) => edge.from.nodeId in graph.nodes && edge.to.nodeId in graph.nodes,
  );

  const targets = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    targets.get(edge.from.nodeId)?.push(edge.to.nodeId);
  }
  const layerOf = longestPathLayers(
    nodes.map((node) => node.id),
    (id) => targets.get(id) ?? [],
    (id) => isSink(graph.nodes[id]),
  );

  const entities = new Map<string, LayoutEntity>();
  for (const node of nodes) {
    const metrics = measure(node.id);
    entities.set(node.id, {
      id: node.id,
      layer: layerOf(node.id),
      width: metrics.width,
      height: Math.ceil(metrics.height / grid) * grid,
      signal: undefined,
      weight: NODE_WEIGHT,
      y: node.position.y,
      inputRow: (socketKey) => Math.round(metrics.inputRows[socketKey] ?? grid * 1.5),
      outputRow: (socketKey) => Math.round(metrics.outputRows[socketKey] ?? grid * 1.5),
    });
  }
  const entityOf = (nodeId: string): LayoutEntity => {
    const entity = entities.get(nodeId);
    if (entity === undefined) {
      throw new Error(`Layout: no node "${nodeId}"`);
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

/** Every connection and output binding, each traced back through routes to its real source. */
function authoredEdges(graph: EditorGraph, kind: GraphKind): LayoutEdge[] {
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
  const edges: LayoutEdge[] = [];
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
  return edges;
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
