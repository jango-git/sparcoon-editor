import { describe, expect, it } from "vitest";
import { createEditApi } from "../../src/agent/editApi";
import { liveSession, runTransaction, stagedSession } from "../../src/agent/transaction.Internal";
import { RENDER_SINK_ID, SPAWN_SINK_ID } from "../../src/domain/nodePalette";
import { createDefaultEmitter, createInitialState } from "../../src/model/editorState";
import { SignalBus } from "../../src/model/signals";
import { Store } from "../../src/model/store";

/** A store whose document holds two starter emitters (`emitter_a` active) and no meshes. */
function twoEmitterStore(): Store {
  const state = createInitialState();
  const emitters = [createDefaultEmitter("emitter_a", "A"), createDefaultEmitter("emitter_b", "B")];
  state.source = {
    ...state.source,
    scene: { ...state.source.scene, emitters, activeEmitterId: "emitter_a" },
  };
  return new Store(state, new SignalBus());
}

function undoDepth(store: Store): number {
  let depth = 0;
  while (store.canUndo) {
    store.undo();
    depth += 1;
  }
  return depth;
}

/** The live API and a transaction runner over the same store, as `window.sparcoon` wires them. */
function apis(store: Store) {
  return {
    api: createEditApi(liveSession(store)),
    edit: <T>(body: (transaction: ReturnType<typeof createEditApi>) => T): T =>
      runTransaction(store, (staging) => body(createEditApi(stagedSession(staging)))),
  };
}

describe("agent transactions", () => {
  it("lands a whole edit() body as one undo step", () => {
    const store = twoEmitterStore();
    const { edit } = apis(store);
    edit((transaction) => {
      const graph = transaction.graph("emitter_b", "render");
      const node = graph.addNode("constant");
      graph.connect({ node, socket: "out" }, { node: RENDER_SINK_ID, socket: "albedo" });
      transaction.timeline.addBurst("emitter_b", 0.5, 10);
    });
    expect(undoDepth(store)).toBe(1);
  });

  it("applies nothing when the body throws part-way", () => {
    const store = twoEmitterStore();
    const before = store.getSource();
    const { edit } = apis(store);
    expect(() =>
      edit((transaction) => {
        transaction.graph("emitter_b", "render").addNode("constant");
        transaction.graph("emitter_b", "render").addNode("no-such-node");
      }),
    ).toThrow(/not_found/);
    expect(store.getSource()).toBe(before);
    expect(store.canUndo).toBe(false);
  });

  it("refuses an async body", () => {
    const store = twoEmitterStore();
    const { edit } = apis(store);
    expect(() => edit(async () => {})).toThrow(/synchronous/);
  });

  it("records nothing for a call that changes nothing", () => {
    const store = twoEmitterStore();
    const { api } = apis(store);
    api.scene.setHidden("emitter_a", false);
    expect(store.canUndo).toBe(false);
  });

  it("lets later calls in a body read what earlier ones wrote", () => {
    const store = twoEmitterStore();
    const { edit } = apis(store);
    const count = edit((transaction) => {
      transaction.graph("emitter_a", "render").addNode("constant");
      return transaction.graph("emitter_a", "render").get().nodes.length;
    });
    // The starter render graph's three nodes and its sink, plus the one just added.
    expect(count).toBe(5);
    expect(Object.keys(store.getSource().scene.emitters[0].renderGraph.nodes)).toHaveLength(5);
  });
});

describe("agent transaction guards", () => {
  it("refuses a top-level edit from inside an edit() body, applying neither", () => {
    const store = twoEmitterStore();
    const before = store.getSource();
    const { api, edit } = apis(store);
    expect(() =>
      edit((transaction) => {
        transaction.timeline.addBurst("emitter_a", 1, 5);
        api.scene.addEmitter();
      }),
    ).toThrow(/transaction argument/);
    expect(store.getSource()).toBe(before);
  });

  it("refuses to overwrite a document that moved while the body ran", () => {
    const store = twoEmitterStore();
    const { api, edit } = apis(store);
    api.scene.rename("emitter_a", "Renamed");
    expect(() =>
      edit((transaction) => {
        transaction.timeline.addBurst("emitter_a", 1, 5);
        store.undo();
      }),
    ).toThrow(/document changed/);
    // The undo stands; the body's burst was not written over it.
    expect(store.getSource().scene.emitters[0].name).toBe("A");
    expect(store.getSource().scene.emitters[0].events).toHaveLength(1);
  });
});

describe("agent data boundary", () => {
  it("hands out copies, so changing a read never reaches the document", () => {
    const store = twoEmitterStore();
    const { api } = apis(store);
    const view = api.graph("emitter_a", "render").get();
    (view.nodes.find((node) => node.id === "n_albedo")!.params.value as number[])[0] = 42;
    (api.scene.get().emitters[0].events as unknown[]).length = 0;
    const emitter = store.getSource().scene.emitters[0];
    expect((emitter.renderGraph.nodes["n_albedo"].parameters.value as number[])[0]).not.toBe(42);
    expect(emitter.events).toHaveLength(1);
  });

  it("keeps its own copy of what it is given", () => {
    const store = twoEmitterStore();
    const value = [1, 0, 0, 1];
    const id = apis(store).api.graph("emitter_a", "render").addNode("constant", {
      params: { value },
    });
    value[0] = 0.5;
    const stored = store.getSource().scene.emitters[0].renderGraph.nodes[id].parameters.value;
    expect(stored).toEqual([1, 0, 0, 1]);
  });

  it("names a misspelt option key instead of ignoring it", () => {
    const { api } = apis(twoEmitterStore());
    expect(() => api.scene.setTransform("emitter_a", { rotaton: [0, 1, 0] } as never)).toThrow(
      /no "rotaton"/,
    );
    expect(() =>
      api.graph("emitter_a", "render").addNode("constant", { param: {} } as never),
    ).toThrow(/no "param"/);
  });
});

describe("agent graph edits", () => {
  it("edits the addressed owner and makes it active", () => {
    const store = twoEmitterStore();
    const { api } = apis(store);
    const id = api.graph("emitter_b", "render").addNode("constant");
    const [first, second] = store.getSource().scene.emitters;
    expect(second.renderGraph.nodes[id]).toBeDefined();
    expect(first.renderGraph.nodes[id]).toBeUndefined();
    expect(store.getSource().scene.activeEmitterId).toBe("emitter_b");
  });

  it("reads a graph without focusing its owner", () => {
    const store = twoEmitterStore();
    const { api } = apis(store);
    api.graph("emitter_b", "behavior").get();
    expect(store.getSource().scene.activeEmitterId).toBe("emitter_a");
    expect(store.canUndo).toBe(false);
  });

  it("applies params given at creation over the defaults", () => {
    const store = twoEmitterStore();
    const { api } = apis(store);
    const graph = api.graph("emitter_a", "behavior");
    const id = graph.addNode("lifetime", { params: { min: 3, max: 4 }, position: { x: 5, y: 6 } });
    const node = graph.get().nodes.find((candidate) => candidate.id === id);
    expect(node?.params).toMatchObject({ min: 3, max: 4 });
    expect(node?.position).toEqual({ x: 5, y: 6 });
  });

  it("rejects an unknown parameter key and an unknown node type", () => {
    const store = twoEmitterStore();
    const graph = apis(store).api.graph("emitter_a", "behavior");
    expect(() => graph.addNode("lifetime", { params: { nope: 1 } })).toThrow(/invalid_argument/);
    expect(() => graph.addNode("no-such-node")).toThrow(/not_found/);
    expect(() => graph.setParams("n_life", { nope: 1 })).toThrow(/invalid_argument/);
    expect(store.canUndo).toBe(false);
  });

  it("wires into a sink as an output binding and reports it as an edge to the sink", () => {
    const store = twoEmitterStore();
    const graph = apis(store).api.graph("emitter_a", "behavior");
    graph.disconnect({ node: SPAWN_SINK_ID, socket: "position" });
    expect(
      graph
        .get()
        .edges.some((edge) => edge.to.node === SPAWN_SINK_ID && edge.to.socket === "position"),
    ).toBe(false);

    graph.connect(
      { node: "n_pos", socket: "position" },
      { node: SPAWN_SINK_ID, socket: "position" },
    );
    const emitter = store.getSource().scene.emitters[0];
    expect(emitter.behaviorGraph.outputBindings).toContainEqual({
      slot: "position",
      from: { nodeId: "n_pos", socketKey: "position" },
      phase: "spawn",
    });
    expect(graph.get().edges).toContainEqual({
      from: { node: "n_pos", socket: "position" },
      to: { node: SPAWN_SINK_ID, socket: "position" },
    });
  });

  it("wires node to node as a connection, replacing the input's previous feed", () => {
    const store = twoEmitterStore();
    const graph = apis(store).api.graph("emitter_a", "render");
    const lookAt = graph.addNode("look-at-camera");
    graph.connect({ node: lookAt, socket: "out" }, { node: "n_transform", socket: "rotation" });
    const feeds = store
      .getSource()
      .scene.emitters[0].renderGraph.connections.filter(
        (connection) =>
          connection.to.nodeId === "n_transform" && connection.to.socketKey === "rotation",
      );
    expect(feeds).toHaveLength(1);
    expect(feeds[0].from.nodeId).toBe(lookAt);
  });

  it("rejects a socket the node does not have", () => {
    const graph = apis(twoEmitterStore()).api.graph("emitter_a", "render");
    expect(() =>
      graph.connect(
        { node: "n_albedo", socket: "missing" },
        { node: RENDER_SINK_ID, socket: "albedo" },
      ),
    ).toThrow(/no output "missing"/);
  });

  it("refuses to remove a sink, and removes an ordinary node with its edges", () => {
    const store = twoEmitterStore();
    const graph = apis(store).api.graph("emitter_a", "render");
    expect(() => graph.removeNode(RENDER_SINK_ID)).toThrow(/rejected/);
    graph.removeNode("n_albedo");
    const view = graph.get();
    expect(view.nodes.some((node) => node.id === "n_albedo")).toBe(false);
    expect(view.edges.some((edge) => edge.from.node === "n_albedo")).toBe(false);
  });

  it("keeps attributes to the behavior graph", () => {
    const store = twoEmitterStore();
    const { api } = apis(store);
    expect(() => api.graph("emitter_a", "render").addAttribute("heat", "float")).toThrow(
      /invalid_argument/,
    );
    api.graph("emitter_a", "behavior").addAttribute("heat", "float");
    expect(api.graph("emitter_a", "behavior").get().attributes).toEqual([
      { name: "heat", type: "float" },
    ]);
    expect(() => api.graph("emitter_a", "behavior").addAttribute("heat", "float")).toThrow(
      /rejected/,
    );
  });

  it("rejects an unknown owner and a mesh's behavior graph", () => {
    const store = twoEmitterStore();
    const { api } = apis(store);
    expect(() => api.graph("emitter_x", "render")).toThrow(/not_found/);
    const mesh = api.scene.addMesh();
    expect(() => api.graph(mesh, "behavior")).toThrow(/no behavior graph/);
    expect(() => api.graph("emitter_a", "material")).toThrow(/invalid_argument/);
  });

  it("describes a placed sink with its graph's attribute slots", () => {
    const store = twoEmitterStore();
    const graph = apis(store).api.graph("emitter_a", "behavior");
    graph.addAttribute("heat", "float");
    const keys = graph.describeNode(SPAWN_SINK_ID).inputs.map((socket) => socket.key);
    expect(keys).toContain("position");
    expect(keys).toContain("attr:heat");
  });
});

describe("agent scene and timeline edits", () => {
  it("keeps the last emitter", () => {
    const store = new Store(createInitialState(), new SignalBus());
    const { api } = apis(store);
    expect(() => api.scene.remove("emitter_1")).toThrow(/rejected/);
    const added = api.scene.addEmitter();
    api.scene.remove(added);
    expect(api.scene.get().emitters.map((emitter) => emitter.id)).toEqual(["emitter_1"]);
  });

  it("renames the project through the VFX group's id", () => {
    const store = twoEmitterStore();
    const { api } = apis(store);
    api.scene.rename(api.scene.get().vfx.id, "Fireworks");
    api.scene.rename("emitter_b", "Sparks");
    expect(api.scene.get().name).toBe("Fireworks");
    expect(api.scene.get().emitters[1].name).toBe("Sparks");
    expect(() => api.scene.rename("emitter_b", "  ")).toThrow(/invalid_argument/);
  });

  it("takes rotations in degrees and reports them back the same way", () => {
    const store = twoEmitterStore();
    const { api } = apis(store);
    api.scene.setTransform("emitter_a", { position: [1, 2, 3], rotation: [0, 90, 0] });
    const transform = api.scene.get().emitters[0].transform;
    expect(transform.position).toEqual([1, 2, 3]);
    expect(transform.rotation[1]).toBeCloseTo(90);
    expect(transform.scale).toEqual([1, 1, 1]);
    expect(() => api.scene.setTransform("emitter_a", { scale: [1, 2] })).toThrow(
      /invalid_argument/,
    );
  });

  it("adds, edits and removes spawn events, emitters only", () => {
    const store = twoEmitterStore();
    const { api } = apis(store);
    const burst = api.timeline.addBurst("emitter_a", 1, 50);
    api.timeline.updateEvent("emitter_a", burst, { count: 70 });
    expect(api.scene.get().emitters[0].events).toContainEqual({
      id: burst,
      kind: "burst",
      time: 1,
      count: 70,
    });
    // A play event's field on a burst would be dropped by the command; the API names it instead.
    expect(() => api.timeline.updateEvent("emitter_a", burst, { rate: 5 })).toThrow(
      /burst event has no field "rate"/,
    );
    api.timeline.removeEvent("emitter_a", burst);
    expect(() => api.timeline.removeEvent("emitter_a", burst)).toThrow(/not_found/);
    const mesh = api.scene.addMesh();
    expect(() => api.timeline.addBurst(mesh, 0, 1)).toThrow(/only emitters/);
  });
});
