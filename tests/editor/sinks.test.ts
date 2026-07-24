import { describe, expect, it } from "vitest";
import {
  GraphKind,
  RENDER_SINK_ID,
  RENDER_SINK_TYPE,
  SPAWN_EXPECTED_CAPACITY_PARAM,
  SPAWN_SINK_ID,
  SPAWN_SINK_TYPE,
  SPAWN_TRY_GPU_SIMULATION_PARAM,
  UPDATE_SINK_ID,
  UPDATE_SINK_TYPE,
  isSinkType,
  metaForNode,
  paletteForKind,
  readRenderSinkConfig,
  readSpawnSinkConfig,
  sinkMeta,
  sinkPhase,
} from "../../src/domain/nodePalette";
import { createEmptyGraph } from "../../src/domain/graphModel";
import { createRenderSink, ensureSinks, isSink } from "../../src/domain/sinks";
import { serializeGraph } from "../../src/domain/serialize";
import { createInitialState } from "../../src/model/editorState";
import { Store } from "../../src/model/store";
import { SignalBus } from "../../src/model/signals";
import {
  addAttribute,
  addConnection,
  addNode,
  addOutputBinding,
  removeAttribute,
  renameAttribute,
  setAttributeType,
} from "../../src/model/commands";
import { selectBehaviorGraph, selectRenderGraph } from "../../src/model/selectors";
import { nodeTextEntry } from "../helpers/nodeTextDictionary";

describe("output sink nodes", () => {
  it("ensureSinks adds the right sinks per kind and is idempotent", () => {
    const render = ensureSinks(createEmptyGraph(), GraphKind.Render);
    expect(render.nodes[RENDER_SINK_ID].type).toBe(RENDER_SINK_TYPE);
    expect(render.nodes[SPAWN_SINK_ID]).toBeUndefined();
    expect(ensureSinks(render, GraphKind.Render)).toBe(render);

    const behavior = ensureSinks(createEmptyGraph(), GraphKind.Behavior);
    expect(behavior.nodes[SPAWN_SINK_ID].type).toBe(SPAWN_SINK_TYPE);
    expect(behavior.nodes[UPDATE_SINK_ID].type).toBe(UPDATE_SINK_TYPE);
    expect(behavior.nodes[RENDER_SINK_ID]).toBeUndefined();

    expect(ensureSinks(behavior, GraphKind.Behavior)).toBe(behavior);
  });

  it("readRenderSinkConfig reads geometry/toggles from the surface sink", () => {
    const graph = ensureSinks(createEmptyGraph(), GraphKind.Render);
    graph.nodes[RENDER_SINK_ID] = {
      ...graph.nodes[RENDER_SINK_ID],
      parameters: { geometry: "sphere" },
    };
    const config = readRenderSinkConfig(graph);
    expect(config.geometry).toEqual({ kind: "primitive", primitive: "sphere" });
  });

  it("readSpawnSinkConfig defaults tryGpuSimulation to on and reads an explicit override from the spawn sink", () => {
    const blank = ensureSinks(createEmptyGraph(), GraphKind.Behavior);
    expect(readSpawnSinkConfig(blank).tryGpuSimulation).toBe(true);

    const graph = ensureSinks(createEmptyGraph(), GraphKind.Behavior);
    graph.nodes[SPAWN_SINK_ID] = {
      ...graph.nodes[SPAWN_SINK_ID],
      parameters: { [SPAWN_TRY_GPU_SIMULATION_PARAM]: false },
    };
    expect(readSpawnSinkConfig(graph).tryGpuSimulation).toBe(false);
  });

  it("readSpawnSinkConfig defaults expectedCapacity to 256 and reads/coerces it from the spawn sink", () => {
    const blank = ensureSinks(createEmptyGraph(), GraphKind.Behavior);
    expect(readSpawnSinkConfig(blank).expectedCapacity).toBe(256);

    const withValue = (value: unknown): number => {
      const graph = ensureSinks(createEmptyGraph(), GraphKind.Behavior);
      graph.nodes[SPAWN_SINK_ID] = {
        ...graph.nodes[SPAWN_SINK_ID],
        parameters: { [SPAWN_EXPECTED_CAPACITY_PARAM]: value },
      };
      return readSpawnSinkConfig(graph).expectedCapacity;
    };
    expect(withValue(1000)).toBe(1000);
    expect(withValue(12.7)).toBe(12); // floored, not rounded
    expect(withValue(0)).toBe(256); // below the 1-particle floor - default, not clamped
    expect(withValue(-5)).toBe(256);
    expect(withValue("not a number")).toBe(256);
    expect(withValue(undefined)).toBe(256);
  });

  it("a fresh document carries the sinks in both graphs", () => {
    const emitter = createInitialState().source.scene.emitters[0];
    expect(isSink(emitter.renderGraph.nodes[RENDER_SINK_ID])).toBe(true);
    expect(isSink(emitter.behaviorGraph.nodes[SPAWN_SINK_ID])).toBe(true);
    expect(isSink(emitter.behaviorGraph.nodes[UPDATE_SINK_ID])).toBe(true);
  });

  it("classifies sink types and their phases", () => {
    expect(isSinkType(SPAWN_SINK_TYPE)).toBe(true);
    expect(isSinkType("constant")).toBe(false);
    expect(sinkPhase(SPAWN_SINK_TYPE)).toBe("spawn");
    expect(sinkPhase(UPDATE_SINK_TYPE)).toBe("update");
    expect(sinkPhase(RENDER_SINK_TYPE)).toBeUndefined();
  });

  it("serializeGraph drops the sinks, keeps user nodes, and carries binding phase", () => {
    const graph = ensureSinks(
      {
        ...createEmptyGraph(),
        nodes: {
          pos: { id: "pos", type: "spawn-box", parameters: {}, position: { x: 0, y: 0 } },
        },
        outputBindings: [
          { slot: "position", from: { nodeId: "pos", socketKey: "position" }, phase: "spawn" },
        ],
      },
      GraphKind.Behavior,
    );

    const snapshot = serializeGraph(graph);
    expect(snapshot.nodes[SPAWN_SINK_ID]).toBeUndefined();
    expect(snapshot.nodes[UPDATE_SINK_ID]).toBeUndefined();
    expect(snapshot.nodes.pos).toEqual({ type: "spawn-box", params: {} });
    expect(snapshot.outputBindings).toEqual([
      { slot: "position", from: { nodeId: "pos", socketKey: "position" }, phase: "spawn" },
    ]);
  });

  it("serializeGraph drops the surface sink; its render bindings survive", () => {
    const graph = ensureSinks(
      {
        ...createEmptyGraph(),
        nodes: {
          col: {
            id: "col",
            type: "constant",
            parameters: { type: "vec4", value: [1, 1, 1, 1] },
            position: { x: 0, y: 0 },
          },
        },
        outputBindings: [{ slot: "albedo", from: { nodeId: "col", socketKey: "out" } }],
      },
      GraphKind.Render,
    );

    const snapshot = serializeGraph(graph, GraphKind.Render);
    expect(snapshot.nodes[RENDER_SINK_ID]).toBeUndefined();
    expect(snapshot.outputBindings).toEqual(
      expect.arrayContaining([{ slot: "albedo", from: { nodeId: "col", socketKey: "out" } }]),
    );
  });

  it("behavior sinks expose vec3 position + lifetime, not the per-axis scalar slots", () => {
    const spawnKeys = sinkMeta(SPAWN_SINK_TYPE).inputs.map((s) => s.key);
    const updateKeys = sinkMeta(UPDATE_SINK_TYPE).inputs.map((s) => s.key);
    // spawn: vec3 position + birth-only lifetime; no positionX/Y/Z decomposition.
    expect(spawnKeys).toEqual(["position", "lifetime"]);
    expect(sinkMeta(SPAWN_SINK_TYPE).inputs.find((s) => s.key === "position")?.type).toBe("vec3");
    expect(sinkMeta(SPAWN_SINK_TYPE).inputs.find((s) => s.key === "lifetime")?.type).toBe("float");
    // update: vec3 position only (lifetime is birth-only).
    expect(updateKeys).toEqual(["position"]);
  });

  it("the spawn sink carries the GPU-simulation opt-in and the expected-capacity param", () => {
    expect(Object.keys(sinkMeta(SPAWN_SINK_TYPE).params).sort()).toEqual([
      SPAWN_EXPECTED_CAPACITY_PARAM,
      SPAWN_TRY_GPU_SIMULATION_PARAM,
    ]);
  });

  it("the surface sink's base-color slot keeps key 'albedo' (ABI) but shows the label 'Color'", () => {
    const albedo = sinkMeta(RENDER_SINK_TYPE).inputs.find((socket) => socket.key === "albedo");
    expect(albedo).toBeDefined();
    // Text is resolved by type+key from the node-text dictionary now, not carried on the meta -
    // see i18n/nodeText.ts.
    expect(nodeTextEntry(RENDER_SINK_TYPE)?.inputs?.["albedo"]?.label).toBe("Color");
  });

  it("declared attributes append attr:<name> slots to both behavior sinks", () => {
    const attributes = [{ name: "velocity", type: "vec3" as const }];
    const spawn = sinkMeta(SPAWN_SINK_TYPE, { attributes });
    const update = sinkMeta(UPDATE_SINK_TYPE, { attributes });
    expect(spawn.inputs.map((s) => s.key)).toEqual(["position", "lifetime", "attr:velocity"]);
    expect(update.inputs.map((s) => s.key)).toEqual(["position", "attr:velocity"]);
    expect(spawn.inputs.find((s) => s.key === "attr:velocity")?.type).toBe("vec3");
  });

  it("the surface sink owns albedo + transforms and no lighting-model slots (lighting is nodes now)", () => {
    // Lighting-as-nodes: the surface sink carries no model param and no shading normal/emission
    // slots - those are lighting-node inputs. `albedo` already carries the shaded color.
    const surface = metaForNode(GraphKind.Render, createRenderSink());
    const keys = surface?.inputs.map((s) => s.key) ?? [];
    expect(keys).toContain("albedo");
    expect(keys).not.toContain("normal");
    expect(keys).not.toContain("emission");
    expect(surface?.params.model).toBeUndefined();
  });

  it("the surface sink gates additivity (blending only) and alphaThreshold (not opaque)", () => {
    const inputsFor = (renderMode: string): string[] =>
      metaForNode(GraphKind.Render, {
        type: RENDER_SINK_TYPE,
        parameters: { renderMode },
      })?.inputs.map((s) => s.key) ?? [];

    // Blending: both compositing sockets present.
    expect(inputsFor("blending")).toEqual(
      expect.arrayContaining(["albedo", "additivity", "alphaThreshold"]),
    );
    // alphaHash / alphaTest: the cutoff, but no additivity.
    expect(inputsFor("alphaHash")).toContain("alphaThreshold");
    expect(inputsFor("alphaHash")).not.toContain("additivity");
    expect(inputsFor("alphaTest")).toContain("alphaThreshold");
    // Opaque: neither compositing socket (alpha is forced to 1).
    const opaque = inputsFor("opaque");
    expect(opaque).toContain("albedo");
    expect(opaque).not.toContain("alphaThreshold");
    expect(opaque).not.toContain("additivity");
  });

  it("the particle surface sink carries particleTransform + vertexTransform and the sort param", () => {
    const surface = sinkMeta(RENDER_SINK_TYPE, { renderHost: "particle" });
    const keys = surface.inputs.map((socket) => socket.key);
    expect(keys).toContain("particleTransform");
    expect(keys).toContain("vertexTransform");
    expect(Object.keys(surface.params)).toEqual(
      expect.arrayContaining([
        "renderMode",
        "geometry",
        "sortInterval",
        "castShadow",
        "receiveShadow",
      ]),
    );
  });

  it("the mesh surface sink drops particleTransform and the sort param, keeps geometry + shadows", () => {
    const surface = sinkMeta(RENDER_SINK_TYPE, { renderHost: "mesh" });
    const keys = surface.inputs.map((socket) => socket.key);
    expect(keys).toContain("albedo");
    expect(keys).toContain("vertexTransform");
    expect(keys).not.toContain("particleTransform");
    // The shadow flags ride both hosts; only the camera sort param is particle-only.
    expect(Object.keys(surface.params).sort()).toEqual([
      "castShadow",
      "geometry",
      "receiveShadow",
      "renderMode",
    ]);
    expect(surface.params.sortInterval).toBeUndefined();
  });

  it("the surface sink defaults to the particle host (particleTransform present)", () => {
    expect(sinkMeta(RENDER_SINK_TYPE).inputs.map((socket) => socket.key)).toContain(
      "particleTransform",
    );
  });

  it("the mesh surface sink still gates compositing by render mode", () => {
    const keysFor = (renderMode: "blending" | "opaque" | "alphaHash" | "alphaTest"): string[] =>
      sinkMeta(RENDER_SINK_TYPE, { renderHost: "mesh", renderMode }).inputs.map(
        (socket) => socket.key,
      );
    expect(keysFor("blending")).toEqual(
      expect.arrayContaining(["albedo", "additivity", "alphaThreshold", "vertexTransform"]),
    );
    expect(keysFor("opaque")).not.toContain("alphaThreshold");
    expect(keysFor("alphaHash")).not.toContain("additivity");
  });

  it("never lists the sinks in the add-node palette", () => {
    for (const kind of [GraphKind.Render, GraphKind.Behavior]) {
      expect(paletteForKind(kind).some((m) => isSinkType(m.type))).toBe(false);
    }
  });

  it("materializes an attr:<name> binding into a store-attribute node at serialize", () => {
    const graph = ensureSinks(
      {
        ...createEmptyGraph(),
        nodes: { rand: { id: "rand", type: "random", parameters: {}, position: { x: 0, y: 0 } } },
        attributes: [{ name: "seed", type: "float" }],
        outputBindings: [
          { slot: "attr:seed", from: { nodeId: "rand", socketKey: "out" }, phase: "spawn" },
        ],
      },
      GraphKind.Behavior,
    );

    const snapshot = serializeGraph(graph);
    const storeEntry = Object.entries(snapshot.nodes).find(([, n]) => n.type === "store-attribute");
    expect(storeEntry).toBeDefined();
    const [storeId, storeNode] = storeEntry!;
    expect(storeNode.params).toEqual({ name: "seed", type: "float", phase: "spawn" });
    // producer -> store.value(in), and store.value(out) -> the attr slot.
    expect(snapshot.connections).toContainEqual({
      from: { nodeId: "rand", socketKey: "out" },
      to: { nodeId: storeId, socketKey: "value" },
    });
    expect(snapshot.outputBindings).toContainEqual({
      slot: "attr:seed",
      from: { nodeId: storeId, socketKey: "value" },
      phase: "spawn",
    });
  });
});

describe("attribute commands", () => {
  const freshStore = (): Store => new Store(createInitialState(), new SignalBus());

  it("adds, rejects invalid/duplicate, retypes, and removes attributes", () => {
    const store = freshStore();

    expect(addAttribute(store, "behaviorGraph", "velocity", "vec3")).toBe(true);
    expect(selectBehaviorGraph(store).attributes).toEqual([{ name: "velocity", type: "vec3" }]);

    expect(addAttribute(store, "behaviorGraph", "velocity", "float")).toBe(false); // duplicate
    expect(addAttribute(store, "behaviorGraph", "bad-name", "float")).toBe(false); // invalid name
    expect(addAttribute(store, "behaviorGraph", "Position", "float")).toBe(false); // reserved, case-insensitive
    expect(selectBehaviorGraph(store).attributes).toHaveLength(1);

    setAttributeType(store, "behaviorGraph", "velocity", "vec4");
    expect(selectBehaviorGraph(store).attributes[0].type).toBe("vec4");

    removeAttribute(store, "behaviorGraph", "velocity");
    expect(selectBehaviorGraph(store).attributes).toEqual([]);
  });
});

describe("renameAttribute", () => {
  const freshStore = (): Store => new Store(createInitialState(), new SignalBus());

  it("renames the declaration and remaps the attr:<name> output-binding slot", () => {
    const store = freshStore();
    addAttribute(store, "behaviorGraph", "velocity", "vec3");
    addNode(store, "behaviorGraph", {
      id: "rand1",
      type: "random",
      parameters: {},
      position: { x: 0, y: 0 },
    });
    addOutputBinding(store, "behaviorGraph", {
      slot: "attr:velocity",
      from: { nodeId: "rand1", socketKey: "out" },
      phase: "spawn",
    });

    expect(renameAttribute(store, "behaviorGraph", "velocity", "speed")).toBe(true);

    expect(selectBehaviorGraph(store).attributes).toEqual([{ name: "speed", type: "vec3" }]);
    expect(selectBehaviorGraph(store).outputBindings).toEqual([
      { slot: "attr:speed", from: { nodeId: "rand1", socketKey: "out" }, phase: "spawn" },
    ]);
  });

  it("rejects an invalid, reserved, or duplicate new name, and an unknown old name - without mutating state", () => {
    const store = freshStore();
    addAttribute(store, "behaviorGraph", "velocity", "vec3");
    addAttribute(store, "behaviorGraph", "seed", "float");

    expect(renameAttribute(store, "behaviorGraph", "velocity", "bad-name")).toBe(false);
    expect(renameAttribute(store, "behaviorGraph", "velocity", "Position")).toBe(false);
    expect(renameAttribute(store, "behaviorGraph", "velocity", "seed")).toBe(false); // duplicate
    expect(renameAttribute(store, "behaviorGraph", "ghost", "anything")).toBe(false); // unknown name

    expect(selectBehaviorGraph(store).attributes).toEqual([
      { name: "velocity", type: "vec3" },
      { name: "seed", type: "float" },
    ]);
  });

  it("is a no-op success when the new name equals the old name", () => {
    const store = freshStore();
    addAttribute(store, "behaviorGraph", "velocity", "vec3");
    expect(renameAttribute(store, "behaviorGraph", "velocity", "velocity")).toBe(true);
    expect(selectBehaviorGraph(store).attributes).toEqual([{ name: "velocity", type: "vec3" }]);
  });

  it("re-mints every custom-attribute node reading the attribute, in both graphs, preserving wires and leaving other names alone", () => {
    const store = freshStore();
    addAttribute(store, "behaviorGraph", "velocity", "vec3");
    addAttribute(store, "behaviorGraph", "seed", "float");

    addNode(store, "behaviorGraph", {
      id: "read-b1",
      type: "custom-attribute",
      parameters: { name: "velocity", type: "vec3" },
      position: { x: 0, y: 0 },
    });
    addNode(store, "behaviorGraph", {
      id: "read-b2",
      type: "custom-attribute",
      parameters: { name: "seed", type: "float" }, // a different attribute - must survive untouched
      position: { x: 0, y: 0 },
    });
    addNode(store, "renderGraph", {
      id: "read-r1",
      type: "custom-attribute",
      parameters: { name: "velocity", type: "vec3" },
      position: { x: 0, y: 0 },
    });
    // The components-fanout twin must be retargeted too (this is exactly the bug that shipped
    // before: only "custom-attribute" was swept, orphaning this one under the old name).
    addNode(store, "behaviorGraph", {
      id: "read-b3",
      type: "custom-attribute-split",
      parameters: { name: "velocity", type: "vec3" },
      position: { x: 0, y: 0 },
    });
    addNode(store, "behaviorGraph", {
      id: "consumer",
      type: "add",
      parameters: {},
      position: { x: 0, y: 0 },
    });
    addNode(store, "behaviorGraph", {
      id: "tex1",
      type: "texture",
      parameters: { name: "velocity" }, // same string, but a texture ref - must never match
      position: { x: 0, y: 0 },
    });
    addConnection(store, "behaviorGraph", {
      id: "conn1",
      from: { nodeId: "read-b1", socketKey: "value" },
      to: { nodeId: "consumer", socketKey: "a" },
    });
    addConnection(store, "behaviorGraph", {
      id: "conn2",
      from: { nodeId: "read-b3", socketKey: "x" },
      to: { nodeId: "consumer", socketKey: "b" },
    });
    addOutputBinding(store, "renderGraph", {
      slot: "albedo",
      from: { nodeId: "read-r1", socketKey: "value" },
    });

    expect(renameAttribute(store, "behaviorGraph", "velocity", "speed")).toBe(true);

    const behavior = selectBehaviorGraph(store);
    const render = selectRenderGraph(store);

    expect(behavior.nodes["read-b1"]).toBeUndefined();
    const newBehaviorNode = Object.values(behavior.nodes).find(
      (node) => node.type === "custom-attribute" && node.parameters["name"] === "speed",
    );
    expect(newBehaviorNode).toBeDefined();

    expect(behavior.nodes["read-b3"]).toBeUndefined();
    const newComponentsNode = Object.values(behavior.nodes).find(
      (node) => node.type === "custom-attribute-split" && node.parameters["name"] === "speed",
    );
    expect(newComponentsNode).toBeDefined();

    expect(behavior.connections).toEqual([
      {
        id: "conn1",
        from: { nodeId: newBehaviorNode!.id, socketKey: "value" },
        to: { nodeId: "consumer", socketKey: "a" },
      },
      {
        id: "conn2",
        from: { nodeId: newComponentsNode!.id, socketKey: "x" },
        to: { nodeId: "consumer", socketKey: "b" },
      },
    ]);

    expect(behavior.nodes["read-b2"]).toEqual({
      id: "read-b2",
      type: "custom-attribute",
      parameters: { name: "seed", type: "float" },
      position: { x: 0, y: 0 },
    });
    expect(behavior.nodes["tex1"]).toEqual({
      id: "tex1",
      type: "texture",
      parameters: { name: "velocity" },
      position: { x: 0, y: 0 },
    });

    expect(render.nodes["read-r1"]).toBeUndefined();
    const newRenderNode = Object.values(render.nodes).find(
      (node) => node.type === "custom-attribute" && node.parameters["name"] === "speed",
    );
    expect(newRenderNode).toBeDefined();
    expect(render.outputBindings).toEqual([
      { slot: "albedo", from: { nodeId: newRenderNode!.id, socketKey: "value" } },
    ]);
  });
});
