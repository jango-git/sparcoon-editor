import { describe, expect, it } from "vitest";
import type {
  EditorGraph,
  GraphConnection,
  GraphNode,
  GraphOutputBinding,
} from "../../src/domain/graphModel";
import { createEmptyGraph } from "../../src/domain/graphModel";
import { FX_STANDARD_NODES } from "../../src/engine/nodes-std/index";
import { migrateRenamedInputs } from "../../src/persistence/renamedInputs";

function node(id: string, type: string, parameters: Record<string, unknown> = {}): GraphNode {
  return { id, type, parameters, position: { x: 0, y: 0 } };
}

function wire(
  id: string,
  from: readonly [nodeId: string, socketKey: string],
  to: readonly [nodeId: string, socketKey: string],
): GraphConnection {
  return {
    id,
    from: { nodeId: from[0], socketKey: from[1] },
    to: { nodeId: to[0], socketKey: to[1] },
  };
}

function graphOf(
  nodes: readonly GraphNode[],
  connections: readonly GraphConnection[] = [],
  outputBindings: readonly GraphOutputBinding[] = [],
): EditorGraph {
  return {
    ...createEmptyGraph(),
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    connections,
    outputBindings,
  };
}

/** The socket keys the current definition of `type` declares. */
function socketKeys(type: string, side: "inputs" | "outputs"): string[] {
  const definition = FX_STANDARD_NODES.find((candidate) => candidate.type === type);
  if (definition === undefined) {
    throw new Error(`no standard node "${type}"`);
  }
  return definition.describe()[side].map((socket) => socket.key);
}

describe("migrateRenamedInputs", () => {
  it("maps only onto keys the current node definitions declare", () => {
    expect(socketKeys("spawn-cylinder", "inputs")).toContain("height");
    expect(socketKeys("spawn-cylinder", "inputs")).not.toContain("length");
    expect(socketKeys("animated-texture", "outputs")).toEqual(
      expect.arrayContaining(["uvFrame", "uvNext"]),
    );
    expect(socketKeys("animated-texture", "outputs")).not.toContain("uvPrevious");
    expect(socketKeys("animated-texture", "outputs")).not.toContain("uvCurrent");
  });

  it("returns a graph with no renamed node types as the same object", () => {
    const graph = graphOf(
      [node("a", "spawn-cone", { length: 2 }), node("b", "gravity")],
      [wire("w", ["b", "velocity"], ["a", "length"])],
    );
    expect(migrateRenamedInputs(graph)).toBe(graph);
  });

  it("moves a renamed input's stored value to its current key, keeping the other params", () => {
    const migrated = migrateRenamedInputs(
      graphOf([node("cyl", "spawn-cylinder", { length: 3, radius: 1 })]),
    );
    expect(migrated.nodes["cyl"].parameters).toEqual({ height: 3, radius: 1 });
  });

  it("keeps the current key when a file holds both the old and the current one", () => {
    const migrated = migrateRenamedInputs(
      graphOf([node("cyl", "spawn-cylinder", { length: 3, height: 5 })]),
    );
    expect(migrated.nodes["cyl"].parameters).toEqual({ height: 5 });
  });

  it("re-targets a wire feeding a renamed input, leaving other node types' same-named inputs alone", () => {
    const migrated = migrateRenamedInputs(
      graphOf(
        [node("src", "constant"), node("cyl", "spawn-cylinder"), node("cone", "spawn-cone")],
        [
          wire("toCylinder", ["src", "out"], ["cyl", "length"]),
          wire("toCone", ["src", "out"], ["cone", "length"]),
        ],
      ),
    );
    expect(migrated.connections).toEqual([
      wire("toCylinder", ["src", "out"], ["cyl", "height"]),
      wire("toCone", ["src", "out"], ["cone", "length"]),
    ]);
  });

  it("re-sources wires and sink bindings reading a renamed output", () => {
    const graph = graphOf(
      [node("anim", "animated-texture"), node("tex", "texture")],
      [
        wire("frame", ["anim", "uvPrevious"], ["tex", "uv"]),
        wire("next", ["anim", "uvCurrent"], ["tex", "uv"]),
        wire("factor", ["anim", "factor"], ["tex", "uv"]),
      ],
      [{ slot: "albedo", from: { nodeId: "anim", socketKey: "uvCurrent" } }],
    );

    const migrated = migrateRenamedInputs(graph);

    expect(migrated.connections.map((connection) => connection.from.socketKey)).toEqual([
      "uvFrame",
      "uvNext",
      "factor",
    ]);
    // An untouched wire keeps its identity.
    expect(migrated.connections[2]).toBe(graph.connections[2]);
    expect(migrated.outputBindings).toEqual([
      { slot: "albedo", from: { nodeId: "anim", socketKey: "uvNext" } },
    ]);
  });

  it("leaves an already-migrated graph unchanged", () => {
    const graph = graphOf(
      [node("cyl", "spawn-cylinder", { length: 3 }), node("anim", "animated-texture")],
      [wire("w", ["anim", "uvPrevious"], ["cyl", "length"])],
      [{ slot: "albedo", from: { nodeId: "anim", socketKey: "uvCurrent" } }],
    );
    const once = migrateRenamedInputs(graph);
    expect(migrateRenamedInputs(once)).toEqual(once);
  });

  it("reads only its own rename tables, whatever names a file stores", () => {
    // Keys that are also Object.prototype members: none of them is a rename.
    const oddType = node("odd", "constructor", { toString: 1, length: 2 });
    const cylinder = node("cyl", "spawn-cylinder", { constructor: 3, length: 4 });
    const graph = graphOf(
      [oddType, cylinder],
      [wire("w", ["odd", "hasOwnProperty"], ["cyl", "constructor"])],
      [{ slot: "albedo", from: { nodeId: "odd", socketKey: "valueOf" } }],
    );
    const migrated = migrateRenamedInputs(graph);
    expect(migrated.nodes["odd"]).toBe(oddType);
    expect(migrated.nodes["cyl"].parameters).toEqual({ constructor: 3, height: 4 });
    expect(migrated.connections).toEqual(graph.connections);
    expect(migrated.outputBindings).toEqual(graph.outputBindings);
  });

  it("passes damaged nodes, wires and bindings through as they are, without throwing", () => {
    const damagedNode = { id: "broken" } as unknown as GraphNode;
    const noParameters = {
      ...node("cyl", "spawn-cylinder"),
      parameters: "junk",
    } as unknown as GraphNode;
    const noTarget = {
      id: "dangling",
      from: { nodeId: "cyl", socketKey: "out" },
    } as unknown as GraphConnection;
    const notAWire = "junk" as unknown as GraphConnection;
    const noSource = { slot: "albedo" } as unknown as GraphOutputBinding;
    const graph = graphOf([damagedNode, noParameters], [noTarget, notAWire], [noSource]);

    let migrated: EditorGraph | undefined;
    expect(() => {
      migrated = migrateRenamedInputs(graph);
    }).not.toThrow();
    expect(migrated?.nodes["broken"]).toBe(damagedNode);
    expect(migrated?.nodes["cyl"]).toBe(noParameters);
    expect(migrated?.connections).toEqual([noTarget, notAWire]);
    expect(migrated?.outputBindings).toEqual([noSource]);
  });
});
