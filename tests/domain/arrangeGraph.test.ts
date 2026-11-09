import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bindingSinkId } from "../../src/domain/graphEdges";
import type { EditorGraph } from "../../src/domain/graphModel";
import { arrangeGraph, type NodeMetrics } from "../../src/domain/layout/arrangeGraph";
import { GraphKind } from "../../src/domain/nodePalette";
import { serializeGraph } from "../../src/domain/serialize";
import { ROUTE_TYPE } from "../../src/domain/fakeNodes";
import {
  addComment,
  arrangeActiveGraph,
  connectSockets,
  addCatalogNode,
} from "../../src/model/commands";
import { createInitialState } from "../../src/model/editorState";
import { SignalBus } from "../../src/model/signals";
import { Store } from "../../src/model/store";
import { deserializeProject } from "../../src/persistence/projectFile";
import { GRID_SIZE } from "../../src/ui/graph/grid";
import { ROUTE_GEOMETRY } from "../../src/ui/graph/routeView";
import { wirePoints } from "../../src/ui/graph/wireRenderer";

/**
 * The auto-layout's promises, checked on every graph of every bundled preset with the wires drawn
 * by the canvas's own elbow rule (`wirePoints`): what compiles is unchanged, no two boxes overlap,
 * no wire runs through a box or along another signal's wire, every wire is level or upright, and
 * every route keeps a grid cell clear of its neighbours. Card metrics are synthesized the way the
 * canvas lays a card out: a header row, then one 24px row per socket, dots inset in the edge cell.
 */

const PRESETS = new URL("../../src/persistence/presets/", import.meta.url);
const DOT_INSET = 13.5;
const ROUTE_DOT_INSET = 10.5;

interface Box {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly route: boolean;
}

/** Sockets a node's wires use, in a stable order, per side. */
function usedSockets(
  graph: EditorGraph,
  kind: GraphKind,
): Map<string, { inputs: string[]; outputs: string[] }> {
  const sockets = new Map<string, { inputs: Set<string>; outputs: Set<string> }>();
  const entry = (id: string) => {
    let found = sockets.get(id);
    if (found === undefined) {
      found = { inputs: new Set(), outputs: new Set() };
      sockets.set(id, found);
    }
    return found;
  };
  for (const connection of graph.connections) {
    entry(connection.from.nodeId).outputs.add(connection.from.socketKey);
    entry(connection.to.nodeId).inputs.add(connection.to.socketKey);
  }
  for (const binding of graph.outputBindings) {
    entry(binding.from.nodeId).outputs.add(binding.from.socketKey);
    entry(bindingSinkId(kind, binding)).inputs.add(binding.slot);
  }
  return new Map(
    [...sockets].map(([id, { inputs, outputs }]) => [
      id,
      { inputs: [...inputs].sort(), outputs: [...outputs].sort() },
    ]),
  );
}

function syntheticMetrics(graph: EditorGraph, kind: GraphKind): (nodeId: string) => NodeMetrics {
  const sockets = usedSockets(graph, kind);
  return (nodeId) => {
    const { inputs, outputs } = sockets.get(nodeId) ?? { inputs: [], outputs: [] };
    const rows = (keys: readonly string[]) =>
      Object.fromEntries(keys.map((key, index) => [key, GRID_SIZE * 1.5 + GRID_SIZE * index]));
    const cells = 6 + ([...nodeId].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 6);
    return {
      width: cells * GRID_SIZE,
      // Not a whole number of cells, as a sink with a footer is not.
      height: GRID_SIZE * (1 + Math.max(1, inputs.length, outputs.length)) + 9,
      inputRows: rows(inputs),
      outputRows: rows(outputs),
    };
  };
}

function arrange(graph: EditorGraph, kind: GraphKind): EditorGraph {
  let counter = 1_000_000;
  return arrangeGraph(graph, kind, {
    grid: GRID_SIZE,
    route: ROUTE_GEOMETRY,
    measure: syntheticMetrics(graph, kind),
    mintId: (prefix) => `${prefix}_${++counter}`,
  });
}

/** Everything the layout promises about `arranged`, as a list of broken promises. */
function layoutProblems(
  arranged: EditorGraph,
  kind: GraphKind,
  measure: (id: string) => NodeMetrics,
): string[] {
  const problems: string[] = [];
  const boxes: Box[] = Object.values(arranged.nodes).map((node) => {
    const route = node.type === ROUTE_TYPE;
    const metrics = route ? undefined : measure(node.id);
    return {
      id: node.id,
      x: node.position.x,
      y: node.position.y,
      width: metrics?.width ?? ROUTE_GEOMETRY.width,
      height: metrics?.height ?? GRID_SIZE,
      route,
    };
  });
  const byId = new Map(boxes.map((box) => [box.id, box]));
  for (const box of boxes) {
    if (box.x % GRID_SIZE !== 0 || box.y % GRID_SIZE !== 0) {
      problems.push(`${box.id} off the grid`);
    }
  }
  const dot = (nodeId: string, socketKey: string, side: "input" | "output") => {
    const box = byId.get(nodeId)!;
    if (box.route) {
      return {
        x: box.x + (side === "input" ? ROUTE_DOT_INSET : box.width - ROUTE_DOT_INSET),
        y: box.y + ROUTE_GEOMETRY.row,
      };
    }
    const metrics = measure(nodeId);
    const row = (side === "input" ? metrics.inputRows : metrics.outputRows)[socketKey];
    expect(row, `${nodeId}.${socketKey}`).toBeDefined();
    return { x: box.x + (side === "input" ? DOT_INSET : box.width - DOT_INSET), y: box.y + row };
  };

  // Each wire's signal is the real socket at the start of its route chain.
  const feeds = new Map(
    arranged.connections.map((connection) => [connection.to.nodeId, connection.from]),
  );
  const signalOf = (from: { nodeId: string; socketKey: string }): string => {
    let current = from;
    while (byId.get(current.nodeId)?.route === true) {
      current = feeds.get(current.nodeId)!;
    }
    return `${current.nodeId}.${current.socketKey}`;
  };
  const wires = [
    ...arranged.connections.map((connection) => ({
      from: connection.from,
      to: connection.to,
    })),
    ...arranged.outputBindings.map((binding) => ({
      from: binding.from,
      to: { nodeId: bindingSinkId(kind, binding), socketKey: binding.slot },
    })),
  ];
  const segments: {
    a: { x: number; y: number };
    b: { x: number; y: number };
    signal: string;
    ends: string[];
  }[] = [];
  for (const wire of wires) {
    const points = wirePoints(
      dot(wire.from.nodeId, wire.from.socketKey, "output"),
      dot(wire.to.nodeId, wire.to.socketKey, "input"),
    );
    for (let index = 0; index < 3; index++) {
      const a = points[index];
      const b = points[index + 1];
      if (a.x !== b.x && a.y !== b.y) {
        problems.push(`slanted wire ${wire.from.nodeId} -> ${wire.to.nodeId}`);
      }
      if (a.x !== b.x || a.y !== b.y) {
        segments.push({
          a,
          b,
          signal: signalOf(wire.from),
          ends: [wire.from.nodeId, wire.to.nodeId],
        });
      }
    }
  }

  for (let first = 0; first < boxes.length; first++) {
    for (let second = first + 1; second < boxes.length; second++) {
      const a = boxes[first];
      const b = boxes[second];
      const rowsOverlap = a.y < b.y + b.height && b.y < a.y + a.height;
      if (rowsOverlap && a.x < b.x + b.width && b.x < a.x + a.width) {
        problems.push(`${a.id} overlaps ${b.id}`);
      }
      if (rowsOverlap && (a.route || b.route)) {
        const gap = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
        if (gap >= 0 && gap < GRID_SIZE) {
          problems.push(`${a.id} crowds ${b.id}`);
        }
      }
    }
  }
  for (const segment of segments) {
    const left = Math.min(segment.a.x, segment.b.x);
    const right = Math.max(segment.a.x, segment.b.x);
    const top = Math.min(segment.a.y, segment.b.y);
    const bottom = Math.max(segment.a.y, segment.b.y);
    for (const box of boxes) {
      if (segment.ends.includes(box.id)) {
        continue;
      }
      if (
        right > box.x + 1 &&
        left < box.x + box.width - 1 &&
        bottom > box.y + 1 &&
        top < box.y + box.height - 1
      ) {
        problems.push(`wire of ${segment.signal} through ${box.id}`);
      }
    }
  }
  for (let first = 0; first < segments.length; first++) {
    for (let second = first + 1; second < segments.length; second++) {
      const a = segments[first];
      const b = segments[second];
      if (a.signal === b.signal) {
        continue;
      }
      const level = a.a.y === a.b.y && b.a.y === b.b.y && a.a.y === b.a.y;
      const upright = a.a.x === a.b.x && b.a.x === b.b.x && a.a.x === b.a.x;
      if (!level && !upright) {
        continue;
      }
      const along = (s: typeof a) =>
        (level ? [s.a.x, s.b.x] : [s.a.y, s.b.y]).sort((p, q) => p - q);
      const [aStart, aEnd] = along(a);
      const [bStart, bEnd] = along(b);
      if (Math.min(aEnd, bEnd) - Math.max(aStart, bStart) > (level ? 0 : -1)) {
        problems.push(`wires of ${a.signal} and ${b.signal} run together`);
      }
    }
  }
  return problems;
}

const presetGraphs = readdirSync(PRESETS)
  .filter((name) => name.endsWith(".json"))
  .flatMap((fileName) => {
    const source = deserializeProject(readFileSync(new URL(fileName, PRESETS), "utf8"))!;
    return [
      ...source.scene.emitters.flatMap((emitter) => [
        {
          name: `${fileName} ${emitter.name} behavior`,
          graph: emitter.behaviorGraph,
          kind: GraphKind.Behavior,
        },
        {
          name: `${fileName} ${emitter.name} render`,
          graph: emitter.renderGraph,
          kind: GraphKind.Render,
        },
        ...(emitter.trailGraph === undefined
          ? []
          : [
              {
                name: `${fileName} ${emitter.name} trail`,
                graph: emitter.trailGraph,
                kind: GraphKind.Render,
              },
            ]),
      ]),
      ...source.scene.meshes.map((mesh) => ({
        name: `${fileName} ${mesh.name} render`,
        graph: mesh.renderGraph,
        kind: GraphKind.Render,
      })),
    ];
  });

describe("arrangeGraph on the bundled presets", () => {
  it.each(presetGraphs)("$name", ({ graph, kind }) => {
    const arranged = arrange(graph, kind);
    expect(serializeGraph(arranged, kind)).toEqual(serializeGraph(graph, kind));
    expect(arranged.comments).toEqual([]);
    expect(layoutProblems(arranged, kind, syntheticMetrics(graph, kind))).toEqual([]);
  });

  it("arranging an arranged graph changes nothing that compiles and keeps every promise", () => {
    for (const { graph, kind } of presetGraphs.slice(0, 12)) {
      const twice = arrange(arrange(graph, kind), kind);
      expect(serializeGraph(twice, kind)).toEqual(serializeGraph(graph, kind));
      expect(layoutProblems(twice, kind, syntheticMetrics(graph, kind))).toEqual([]);
    }
  });
});

describe("arrangeActiveGraph", () => {
  it("is one undo step that also drops the comments", () => {
    const store = new Store(createInitialState(), new SignalBus());
    const curve = addCatalogNode(store, "renderGraph", "life-ratio", { x: 0, y: 0 })!;
    const remap = addCatalogNode(store, "renderGraph", "remap", { x: 0, y: 0 })!;
    connectSockets(
      store,
      "renderGraph",
      { nodeId: curve, socketKey: "out" },
      { nodeId: remap, socketKey: "value" },
    );
    addComment(store, "renderGraph", { x: 0, y: 0 }, { width: 240, height: 120 });
    const before = store.getSource();

    const graph = before.scene.emitters[0].renderGraph;
    arrangeActiveGraph(store, "renderGraph", {
      grid: GRID_SIZE,
      route: ROUTE_GEOMETRY,
      measure: syntheticMetrics(graph, GraphKind.Render),
    });
    const after = store.getSource().scene.emitters[0].renderGraph;
    expect(after.comments).toEqual([]);
    expect(after.nodes[curve].position.x).toBeLessThan(after.nodes[remap].position.x);

    store.undo();
    expect(store.getSource()).toBe(before);
  });
});
