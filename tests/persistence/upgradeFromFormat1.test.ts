import { describe, expect, it } from "vitest";

import type {
  EditorGraph,
  GraphConnection,
  GraphNode,
  GraphOutputBinding,
} from "../../src/domain/graphModel";
import { createEmptyGraph } from "../../src/domain/graphModel";
import { RENDER_SINK_ID } from "../../src/domain/nodePalette";
import { FX_STANDARD_NODES } from "../../src/engine/nodes-std/index";
import {
  migrateRenamedNodes,
  upgradeFromFormat1,
} from "../../src/persistence/upgrades/fromFormat1";

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

describe("migrateRenamedNodes", () => {
  it("maps only onto keys the current node definitions declare", () => {
    expect(socketKeys("random-cylinder-point", "inputs")).toContain("height");
    expect(socketKeys("random-cylinder-point", "inputs")).not.toContain("length");
    expect(socketKeys("animated-texture", "outputs")).toEqual(
      expect.arrayContaining(["uvFrame", "uvNext"]),
    );
    expect(socketKeys("animated-texture", "outputs")).not.toContain("uvPrevious");
    expect(socketKeys("animated-texture", "outputs")).not.toContain("uvCurrent");
  });

  it("maps old node types onto types the current definitions declare", () => {
    for (const shape of ["box", "cone", "cylinder", "disc", "sphere", "torus"]) {
      const migrated = migrateRenamedNodes(graphOf([node("n", `spawn-${shape}`)]));
      const type = migrated.nodes["n"].type;
      expect(type).toBe(`random-${shape}-point`);
      expect(FX_STANDARD_NODES.some((definition) => definition.type === type)).toBe(true);
    }
  });

  it("renames a node's type, keeping its id, parameters, wires and sink bindings", () => {
    const sphere = node("s", "spawn-sphere", { radius: 2, surfaceOnly: true });
    const graph = graphOf(
      [node("src", "constant"), sphere],
      [wire("w", ["src", "out"], ["s", "radius"])],
      [{ slot: "position", from: { nodeId: "s", socketKey: "position" } }],
    );
    const migrated = migrateRenamedNodes(graph);
    expect(migrated.nodes["s"]).toEqual({ ...sphere, type: "random-sphere-point" });
    expect(migrated.nodes["src"]).toBe(graph.nodes["src"]);
    expect(migrated.connections).toEqual(graph.connections);
    expect(migrated.outputBindings).toEqual(graph.outputBindings);
  });

  it("renames an old cylinder's type and then its renamed input", () => {
    const migrated = migrateRenamedNodes(
      graphOf(
        [node("src", "constant"), node("cyl", "spawn-cylinder", { length: 3 })],
        [wire("w", ["src", "out"], ["cyl", "length"])],
      ),
    );
    expect(migrated.nodes["cyl"].type).toBe("random-cylinder-point");
    expect(migrated.nodes["cyl"].parameters).toEqual({ height: 3 });
    expect(migrated.connections).toEqual([wire("w", ["src", "out"], ["cyl", "height"])]);
  });

  it("returns a graph with no renamed node types as the same object", () => {
    const graph = graphOf(
      [node("a", "random-cone-point", { length: 2 }), node("b", "gravity")],
      [wire("w", ["b", "velocity"], ["a", "length"])],
    );
    expect(migrateRenamedNodes(graph)).toBe(graph);
  });

  it("moves a renamed input's stored value to its current key, keeping the other params", () => {
    const migrated = migrateRenamedNodes(
      graphOf([node("cyl", "spawn-cylinder", { length: 3, radius: 1 })]),
    );
    expect(migrated.nodes["cyl"].parameters).toEqual({ height: 3, radius: 1 });
  });

  it("keeps the current key when a file holds both the old and the current one", () => {
    const migrated = migrateRenamedNodes(
      graphOf([node("cyl", "spawn-cylinder", { length: 3, height: 5 })]),
    );
    expect(migrated.nodes["cyl"].parameters).toEqual({ height: 5 });
  });

  it("re-targets a wire feeding a renamed input, leaving other node types' same-named inputs alone", () => {
    const migrated = migrateRenamedNodes(
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

    const migrated = migrateRenamedNodes(graph);

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
    const once = migrateRenamedNodes(graph);
    expect(migrateRenamedNodes(once)).toEqual(once);
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
    const migrated = migrateRenamedNodes(graph);
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
      migrated = migrateRenamedNodes(graph);
    }).not.toThrow();
    expect(migrated?.nodes["broken"]).toBe(damagedNode);
    expect(migrated?.nodes["cyl"]).toEqual({ ...noParameters, type: "random-cylinder-point" });
    expect(migrated?.connections).toEqual([noTarget, notAWire]);
    expect(migrated?.outputBindings).toEqual([noSource]);
  });
});

describe("upgradeFromFormat1", () => {
  const cylinder = node("cyl", "spawn-cylinder", { length: 3 });
  const renamed = node("cyl", "random-cylinder-point", { height: 3 });
  const sink = node(RENDER_SINK_ID, "surface-sink", { renderMode: "lit", geometry: "box" });
  const stripSink = node(RENDER_SINK_ID, "surface-sink", { renderMode: "lit" });

  it("maps the renames in every graph of every emitter and mesh", () => {
    const graph = { nodes: { cyl: cylinder }, connections: [], outputBindings: [] };
    const upgraded = { nodes: { cyl: renamed }, connections: [], outputBindings: [] };
    const body = {
      name: "fx",
      scene: {
        emitters: [
          {
            id: "e",
            renderGraph: graph,
            behaviorGraph: graph,
            trailGraph: graph,
            ribbonGraph: graph,
          },
        ],
        meshes: [{ id: "m", renderGraph: graph }],
      },
    };
    expect(upgradeFromFormat1(body)).toEqual({
      name: "fx",
      scene: {
        emitters: [
          {
            id: "e",
            renderGraph: upgraded,
            behaviorGraph: upgraded,
            trailGraph: upgraded,
            ribbonGraph: upgraded,
          },
        ],
        meshes: [{ id: "m", renderGraph: upgraded }],
      },
    });
  });

  it("drops the geometry of a trail's and a ribbon's sink, and only theirs", () => {
    const graph = { nodes: { [RENDER_SINK_ID]: sink } };
    const body = {
      scene: {
        emitters: [{ id: "e", renderGraph: graph, trailGraph: graph, ribbonGraph: graph }],
        meshes: [{ id: "m", renderGraph: graph }],
      },
    };
    expect(upgradeFromFormat1(body)).toEqual({
      scene: {
        emitters: [
          {
            id: "e",
            renderGraph: graph,
            trailGraph: { nodes: { [RENDER_SINK_ID]: stripSink } },
            ribbonGraph: { nodes: { [RENDER_SINK_ID]: stripSink } },
          },
        ],
        meshes: [{ id: "m", renderGraph: graph }],
      },
    });
  });

  it("adds nothing a format-1 body lacks", () => {
    const body = {
      scene: { emitters: [{ id: "e", trailGraph: { nodes: { cyl: cylinder } } }] },
    };
    expect(upgradeFromFormat1(body)).toEqual({
      scene: { emitters: [{ id: "e", trailGraph: { nodes: { cyl: renamed } } }] },
    });
  });

  it("passes a body, a scene, an emitter or a graph not shaped as format 1 through as it is", () => {
    for (const body of [undefined, "junk", [], { scene: "junk" }, { scene: { emitters: "x" } }]) {
      expect(upgradeFromFormat1(body)).toEqual(body);
    }
    const damaged = {
      scene: {
        emitters: ["junk", { id: "e", renderGraph: "junk", trailGraph: { nodes: [] } }],
        meshes: [0, { id: "m", renderGraph: { nodes: { [RENDER_SINK_ID]: "junk" } } }],
      },
    };
    expect(upgradeFromFormat1(damaged)).toEqual(damaged);
  });
});
