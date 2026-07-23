import { describe, expect, it } from "vitest";
import { createEmptyGraph, type EditorGraph } from "../../src/domain/graphModel";
import { GraphKind } from "../../src/domain/nodePalette";
import { ROUTE_INPUT_KEY, ROUTE_OUTPUT_KEY, ROUTE_TYPE } from "../../src/domain/fakeNodes";
import { ensureSinks } from "../../src/domain/sinks";
import { serializeGraph } from "../../src/domain/serialize";
import { createInitialState } from "../../src/model/editorState";
import { Store } from "../../src/model/store";
import { SignalBus } from "../../src/model/signals";
import {
  addCatalogNode,
  addConnection,
  addNode,
  dissolveRoute,
  insertRouteOnConnection,
  nextIdentifier,
} from "../../src/model/commands";
import { selectRenderGraph } from "../../src/model/selectors";

/** A render node with an output, placed so wires can be authored between two of them. */
function makeNode(id: string, type: string): EditorGraph["nodes"][string] {
  return { id, type, parameters: {}, position: { x: 0, y: 0 } };
}

describe("route (fake node) serialization", () => {
  it("splices A->route->B down to a direct A->B connection, dropping the route node", () => {
    const graph = ensureSinks(
      {
        ...createEmptyGraph(),
        nodes: {
          a: makeNode("a", "constant"),
          r: makeNode("r", ROUTE_TYPE),
          b: makeNode("b", "binary-op"),
        },
        connections: [
          {
            id: "c1",
            from: { nodeId: "a", socketKey: "out" },
            to: { nodeId: "r", socketKey: ROUTE_INPUT_KEY },
          },
          {
            id: "c2",
            from: { nodeId: "r", socketKey: ROUTE_OUTPUT_KEY },
            to: { nodeId: "b", socketKey: "a" },
          },
        ],
      },
      GraphKind.Render,
    );

    const snapshot = serializeGraph(graph);

    expect(snapshot.nodes["r"]).toBeUndefined();
    expect(snapshot.connections).toEqual([
      { from: { nodeId: "a", socketKey: "out" }, to: { nodeId: "b", socketKey: "a" } },
    ]);
  });

  it("collapses a chain of routes to the original source", () => {
    const graph = ensureSinks(
      {
        ...createEmptyGraph(),
        nodes: {
          a: makeNode("a", "constant"),
          r1: makeNode("r1", ROUTE_TYPE),
          r2: makeNode("r2", ROUTE_TYPE),
          b: makeNode("b", "binary-op"),
        },
        connections: [
          {
            id: "c1",
            from: { nodeId: "a", socketKey: "out" },
            to: { nodeId: "r1", socketKey: ROUTE_INPUT_KEY },
          },
          {
            id: "c2",
            from: { nodeId: "r1", socketKey: ROUTE_OUTPUT_KEY },
            to: { nodeId: "r2", socketKey: ROUTE_INPUT_KEY },
          },
          {
            id: "c3",
            from: { nodeId: "r2", socketKey: ROUTE_OUTPUT_KEY },
            to: { nodeId: "b", socketKey: "a" },
          },
        ],
      },
      GraphKind.Render,
    );

    const snapshot = serializeGraph(graph);

    expect(snapshot.connections).toEqual([
      { from: { nodeId: "a", socketKey: "out" }, to: { nodeId: "b", socketKey: "a" } },
    ]);
  });

  it("drops an edge fed by a dangling (unconnected) route", () => {
    const graph = ensureSinks(
      {
        ...createEmptyGraph(),
        nodes: {
          r: makeNode("r", ROUTE_TYPE),
          b: makeNode("b", "binary-op"),
        },
        connections: [
          {
            id: "c2",
            from: { nodeId: "r", socketKey: ROUTE_OUTPUT_KEY },
            to: { nodeId: "b", socketKey: "a" },
          },
        ],
      },
      GraphKind.Render,
    );

    const snapshot = serializeGraph(graph);

    expect(snapshot.nodes["r"]).toBeUndefined();
    expect(snapshot.connections).toEqual([]);
  });

  it("resolves a route feeding an output binding back to the real source", () => {
    const graph = ensureSinks(
      {
        ...createEmptyGraph(),
        nodes: {
          a: makeNode("a", "constant"),
          r: makeNode("r", ROUTE_TYPE),
        },
        connections: [
          {
            id: "c1",
            from: { nodeId: "a", socketKey: "out" },
            to: { nodeId: "r", socketKey: ROUTE_INPUT_KEY },
          },
        ],
        outputBindings: [{ slot: "albedo", from: { nodeId: "r", socketKey: ROUTE_OUTPUT_KEY } }],
      },
      GraphKind.Render,
    );

    const snapshot = serializeGraph(graph);

    expect(snapshot.outputBindings).toEqual([
      { slot: "albedo", from: { nodeId: "a", socketKey: "out" } },
    ]);
  });
});

describe("insertRouteOnConnection command", () => {
  it("replaces the connection with source->route and route->target", () => {
    const store = new Store(createInitialState(), new SignalBus());
    const sourceId = addCatalogNode(store, "renderGraph", "constant", { x: 0, y: 0 })!;
    const targetId = addCatalogNode(store, "renderGraph", "binary-op", { x: 200, y: 0 })!;
    const connId = nextIdentifier("conn");
    addConnection(store, "renderGraph", {
      id: connId,
      from: { nodeId: sourceId, socketKey: "out" },
      to: { nodeId: targetId, socketKey: "a" },
    });

    const routeId = insertRouteOnConnection(store, "renderGraph", connId, { x: 100, y: 0 })!;

    const graph = selectRenderGraph(store);
    expect(graph.nodes[routeId].type).toBe(ROUTE_TYPE);
    expect(graph.connections.find((c) => c.id === connId)).toBeUndefined();
    // The two spliced edges: source -> route.in and route.out -> target.
    expect(
      graph.connections.some(
        (c) =>
          c.from.nodeId === sourceId &&
          c.to.nodeId === routeId &&
          c.to.socketKey === ROUTE_INPUT_KEY,
      ),
    ).toBe(true);
    expect(
      graph.connections.some(
        (c) =>
          c.from.nodeId === routeId &&
          c.from.socketKey === ROUTE_OUTPUT_KEY &&
          c.to.nodeId === targetId,
      ),
    ).toBe(true);
    // The route splices out on serialize: the compiled graph sees a direct source->target edge.
    const snapshot = serializeGraph(graph);
    expect(snapshot.connections).toContainEqual({
      from: { nodeId: sourceId, socketKey: "out" },
      to: { nodeId: targetId, socketKey: "a" },
    });
  });
});

describe("dissolveRoute command", () => {
  it("removes the route but reconnects the wire it carried", () => {
    const store = new Store(createInitialState(), new SignalBus());
    const sourceId = addCatalogNode(store, "renderGraph", "constant", { x: 0, y: 0 })!;
    const targetId = addCatalogNode(store, "renderGraph", "binary-op", { x: 200, y: 0 })!;
    addNode(store, "renderGraph", makeNode("r", ROUTE_TYPE));
    addConnection(store, "renderGraph", {
      id: "c1",
      from: { nodeId: sourceId, socketKey: "out" },
      to: { nodeId: "r", socketKey: ROUTE_INPUT_KEY },
    });
    addConnection(store, "renderGraph", {
      id: "c2",
      from: { nodeId: "r", socketKey: ROUTE_OUTPUT_KEY },
      to: { nodeId: targetId, socketKey: "a" },
    });

    dissolveRoute(store, "renderGraph", "r");

    const graph = selectRenderGraph(store);
    expect(graph.nodes["r"]).toBeUndefined();
    // The two edges collapse into a single direct source -> target connection.
    const survivors = graph.connections.filter(
      (c) => c.from.nodeId === sourceId && c.to.nodeId === targetId && c.to.socketKey === "a",
    );
    expect(survivors).toHaveLength(1);
    expect(graph.connections.some((c) => c.from.nodeId === "r" || c.to.nodeId === "r")).toBe(false);
  });
});
