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

  it("reports a render graph lit exactly when a lighting node feeds it", () => {
    const store = twoEmitterStore();
    const graph = apis(store).api.graph("emitter_a", "render");
    expect(graph.get().lit).toBe(false);
    const shade = graph.addNode("lambert-shading");
    graph.connect({ node: "n_albedo", socket: "out" }, { node: shade, socket: "color" });
    graph.connect({ node: shade, socket: "color" }, { node: RENDER_SINK_ID, socket: "albedo" });
    expect(graph.get().lit).toBe(true);
    expect(apis(store).api.graph("emitter_a", "behavior").get().lit).toBeUndefined();
  });

  it("takes the synthesized stage of a node that leaves it to a param", () => {
    const store = twoEmitterStore();
    const graph = apis(store).api.graph("emitter_a", "render");
    graph.setParams("n_albedo", { stage: "vertex" });
    expect(graph.get().nodes.find((node) => node.id === "n_albedo")?.params.stage).toBe("vertex");
    // `lifetime` has a fixed phase, so it has no phase to set.
    expect(() =>
      apis(store).api.graph("emitter_a", "behavior").setParams("n_life", { phase: "update" }),
    ).toThrow(/no parameter "phase"/);
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
  it("keeps the scene's last object, but lets an effect be meshes only", () => {
    const store = new Store(createInitialState(), new SignalBus());
    const { api } = apis(store);
    expect(() => api.scene.remove("emitter_1")).toThrow(/rejected.*last object/);
    const mesh = api.scene.addMesh();
    api.scene.remove("emitter_1");
    expect(api.scene.get().emitters).toEqual([]);
    // The graph editor moves to the mesh, so graph edits and status still have an owner.
    expect(api.scene.get().activeOwnerId).toBe(mesh);
    expect(() => api.scene.remove(mesh)).toThrow(/rejected.*last object/);
    expect(api.graph(mesh, "render").get().ownerId).toBe(mesh);
  });

  it("renames emitters, and points the VFX group's id at project.setName", () => {
    const store = twoEmitterStore();
    const { api } = apis(store);
    api.scene.rename("emitter_b", "Sparks");
    expect(api.scene.get().emitters[1].name).toBe("Sparks");
    expect(() => api.scene.rename("emitter_b", "  ")).toThrow(/invalid_argument/);
    expect(() => api.scene.rename(api.scene.get().vfx.id, "Fireworks")).toThrow(/project\.setName/);
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

  it("switches the timeline between looping and playing once", () => {
    const store = twoEmitterStore();
    const { api } = apis(store);
    expect(api.scene.get().timeline.loop).toBe(true);
    api.timeline.setLoop(false);
    expect(api.scene.get().timeline.loop).toBe(false);
    expect(() => api.timeline.setLoop("no" as never)).toThrow(/invalid_argument/);
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
    // The whole event as one object names the positional signature.
    expect(() => api.timeline.addBurst("emitter_a", { time: 1, count: 5 } as never, 0)).toThrow(
      /invalid_argument.*addBurst\(emitterId, time, count\) takes positional arguments/,
    );
    expect(() => api.timeline.addPlay("emitter_a", { time: 1 } as never, 0, 0)).toThrow(
      /addPlay\(emitterId, time, rate, duration\)/,
    );
  });
});

describe("agent keyframe edits", () => {
  /** `emitter_a` with a float Timeline Value "glow" (inline 0.25) and a vec3 one "tint". */
  function withValues(store: Store): ReturnType<typeof apis>["api"] {
    const { api } = apis(store);
    const graph = api.graph("emitter_a", "render");
    graph.addNode("timeline-value", { params: { name: "glow", type: "float", value: 0.25 } });
    graph.addNode("timeline-value", { params: { name: "tint", type: "vec3", value: [1, 1, 1] } });
    return api;
  }

  function emitterA(api: ReturnType<typeof apis>["api"]) {
    return api.scene.get().emitters[0];
  }

  it("keys transform channels on the frame grid, rotation in degrees", () => {
    const { api } = apis(twoEmitterStore());
    const position = api.timeline.setTransformKey("emitter_a", "position", 0.51, [1, 2, 3]);
    api.timeline.setTransformKey("emitter_a", "rotation", 1, [0, 90, 0]);

    const tracks = emitterA(api).transformTracks;
    const positionTrack = tracks.find((track) => track.channel === "position");
    expect(positionTrack?.keys).toEqual([{ id: position, time: 0.5, value: [1, 2, 3] }]);
    const rotationKey = tracks.find((track) => track.channel === "rotation")?.keys[0];
    expect(rotationKey?.value[1]).toBeCloseTo(90);

    expect(() => api.timeline.setTransformKey("emitter_a", "skew" as never, 0, [0, 0, 0])).toThrow(
      /invalid_argument/,
    );
    expect(() => api.timeline.setTransformKey("emitter_a", "scale", 0, [1, 1])).toThrow(
      /invalid_argument/,
    );
  });

  it("keys the VFX group's transform too", () => {
    const { api } = apis(twoEmitterStore());
    const vfx = api.scene.get().vfx.id;
    api.timeline.setTransformKey(vfx, "scale", 0, [2, 2, 2]);
    expect(api.scene.get().vfx.transformTracks[0]?.keys[0]?.value).toEqual([2, 2, 2]);
  });

  it("refuses a key on an occupied frame unless asked to replace it", () => {
    const { api } = apis(twoEmitterStore());
    const first = api.timeline.setTransformKey("emitter_a", "position", 1, [1, 0, 0]);
    // 1.01 s snaps to the same 30 fps frame.
    expect(() => api.timeline.setTransformKey("emitter_a", "position", 1.01, [2, 0, 0])).toThrow(
      new RegExp(`rejected.*"${first}".*replace: true`),
    );
    const second = api.timeline.setTransformKey("emitter_a", "position", 1, [2, 0, 0], {
      replace: true,
    });
    expect(second).not.toBe(first);
    expect(emitterA(api).transformTracks[0]?.keys).toEqual([
      { id: second, time: 1, value: [2, 0, 0] },
    ]);
    // Another channel's frame is its own.
    expect(() => api.timeline.setTransformKey("emitter_a", "scale", 1, [2, 2, 2])).not.toThrow();
    expect(() =>
      api.timeline.setTransformKey("emitter_a", "scale", 2, [1, 1, 1], { force: true } as never),
    ).toThrow(/invalid_argument/);
    expect(() =>
      api.timeline.setTransformKey("emitter_a", "scale", 2, [1, 1, 1], undefined as never),
    ).not.toThrow();
    expect(() =>
      api.timeline.setTransformKey("emitter_a", "scale", 3, [1, 1, 1], "replace" as never),
    ).toThrow(/invalid_argument.*options must be an object/);
    expect(() =>
      api.timeline.setTransformKey("emitter_a", "scale", 3, [1, 1, 1], { replace: 1 } as never),
    ).toThrow(/invalid_argument.*replace must be a boolean/);
  });

  it("keeps a replaced key's curve unless given another", () => {
    const api = withValues(twoEmitterStore());
    api.timeline.setValueKey("emitter_a", "glow", 1, 0, { ease: "out" });
    api.timeline.setValueKey("emitter_a", "glow", 1, 2, { replace: true });
    expect(emitterA(api).tracks[0]?.keys[0]).toMatchObject({ value: 2, ease: "out" });
    api.timeline.setValueKey("emitter_a", "glow", 1, 3, { replace: true, ease: "in" });
    expect(emitterA(api).tracks[0]?.keys[0]).toMatchObject({ value: 3, ease: "in" });
  });

  it("sets a key's curve, at creation or after, and reports it", () => {
    const api = withValues(twoEmitterStore());
    const position = api.timeline.setTransformKey("emitter_a", "position", 0, [0, 0, 0], {
      ease: "inOut",
    });
    const glow = api.timeline.setValueKey("emitter_a", "glow", 0, 0, { ease: "in" });
    expect(emitterA(api).transformTracks[0]?.keys[0]).toMatchObject({
      id: position,
      ease: "inOut",
    });
    expect(emitterA(api).tracks[0]?.keys[0]).toMatchObject({ id: glow, ease: "in" });

    api.timeline.setKeyEase("emitter_a", glow, "out");
    expect(emitterA(api).tracks[0]?.keys[0]?.ease).toBe("out");
    // Linear is stored as no curve at all.
    api.timeline.setKeyEase("emitter_a", position, "linear");
    expect(emitterA(api).transformTracks[0]?.keys[0]).not.toHaveProperty("ease");

    expect(() => api.timeline.setKeyEase("emitter_a", glow, "bounce" as never)).toThrow(
      /invalid_argument/,
    );
    expect(() =>
      api.timeline.setValueKey("emitter_a", "glow", 1, 1, { ease: "bounce" as never }),
    ).toThrow(/invalid_argument/);
  });

  it("refuses a move that would put two keys of one track on the same frame", () => {
    const store = twoEmitterStore();
    const api = withValues(store);
    const early = api.timeline.setTransformKey("emitter_a", "position", 0, [0, 0, 0]);
    const late = api.timeline.setTransformKey("emitter_a", "position", 1, [1, 0, 0]);
    api.timeline.setValueKey("emitter_a", "glow", 1, 0.5);
    const before = store.getSource();

    expect(() => api.timeline.moveKeys("emitter_a", [{ id: early, time: 1 }])).toThrow(
      /rejected.*would share/,
    );
    expect(store.getSource()).toBe(before);
    // A swap is fine, and so is landing on another track's frame.
    api.timeline.moveKeys("emitter_a", [
      { id: early, time: 1 },
      { id: late, time: 0 },
    ]);
    expect(emitterA(api).transformTracks[0]?.keys.map((key) => key.id)).toEqual([late, early]);
  });

  it("lists the Timeline Values an owner declares and keys them by their own shape", () => {
    const store = twoEmitterStore();
    const api = withValues(store);
    expect(api.timeline.values("emitter_a")).toEqual([
      { name: "glow", type: "float", value: 0.25 },
      { name: "tint", type: "vec3", value: [1, 1, 1] },
    ]);

    const glow = api.timeline.setValueKey("emitter_a", "glow", 0, 0.8);
    api.timeline.setValueKey("emitter_a", "tint", 0, [1, 0, 0]);
    expect(() => api.timeline.setValueKey("emitter_a", "glow", 0, 0.1)).toThrow(/rejected/);
    expect(emitterA(api).tracks).toEqual([
      { name: "glow", keys: [{ id: glow, time: 0, value: 0.8 }] },
      { name: "tint", keys: [expect.objectContaining({ value: [1, 0, 0] })] },
    ]);

    expect(() => api.timeline.setValueKey("emitter_a", "glow", 0, [1, 2])).toThrow(
      /invalid_argument/,
    );
    expect(() => api.timeline.setValueKey("emitter_a", "tint", 0, 1)).toThrow(/invalid_argument/);
    expect(() => api.timeline.setValueKey("emitter_a", "missing", 0, 1)).toThrow(/not_found/);
    expect(() => api.timeline.values(api.scene.get().vfx.id)).toThrow(/no Timeline Values/);
  });

  it("changes a key's value in the shape it already holds", () => {
    const api = withValues(twoEmitterStore());
    const rotation = api.timeline.setTransformKey("emitter_a", "rotation", 0, [0, 0, 0]);
    const glow = api.timeline.setValueKey("emitter_a", "glow", 0, 0.8);

    api.timeline.setKeyValue("emitter_a", rotation, [0, 45, 0]);
    api.timeline.setKeyValue("emitter_a", glow, 0.1);

    expect(emitterA(api).transformTracks[0]?.keys[0]?.value[1]).toBeCloseTo(45);
    expect(emitterA(api).tracks[0]?.keys[0]?.value).toBe(0.1);
    expect(() => api.timeline.setKeyValue("emitter_a", glow, [1, 2, 3])).toThrow(
      /invalid_argument/,
    );
    expect(() => api.timeline.setKeyValue("emitter_b", glow, 0.5)).toThrow(/not_found/);
  });

  it("retimes transform and value keys together, as one undo step", () => {
    const store = twoEmitterStore();
    const api = withValues(store);
    const position = api.timeline.setTransformKey("emitter_a", "position", 0, [1, 0, 0]);
    const glow = api.timeline.setValueKey("emitter_a", "glow", 0, 0.8);
    const before = store.getSource();

    api.timeline.moveKeys("emitter_a", [
      { id: position, time: 2.01 },
      { id: glow, time: 3 },
    ]);
    expect(emitterA(api).transformTracks[0]?.keys[0]?.time).toBe(2);
    expect(emitterA(api).tracks[0]?.keys[0]?.time).toBe(3);

    store.undo();
    expect(store.getSource()).toBe(before);

    // An unknown id refuses the whole batch.
    expect(() =>
      api.timeline.moveKeys("emitter_a", [
        { id: position, time: 1 },
        { id: "key_nope", time: 1 },
      ]),
    ).toThrow(/not_found/);
    expect(store.getSource()).toBe(before);
  });

  it("removes a key, and the track it leaves empty", () => {
    const api = withValues(twoEmitterStore());
    const position = api.timeline.setTransformKey("emitter_a", "position", 0, [1, 0, 0]);
    const glow = api.timeline.setValueKey("emitter_a", "glow", 0, 0.8);
    api.timeline.removeKey("emitter_a", position);
    api.timeline.removeKey("emitter_a", glow);
    expect(emitterA(api).transformTracks).toEqual([]);
    expect(emitterA(api).tracks).toEqual([]);
    expect(() => api.timeline.removeKey("emitter_a", glow)).toThrow(/not_found/);
  });

  it("leaves channels and values to the host code, never the VFX group's", () => {
    const api = withValues(twoEmitterStore());
    api.timeline.setChannelExcluded("emitter_a", "position", true);
    api.timeline.setValueExcluded("emitter_a", "glow", true);
    expect(emitterA(api).excludedChannels).toEqual(["position"]);
    expect(emitterA(api).excludedValues).toEqual(["glow"]);

    api.timeline.setChannelExcluded("emitter_a", "position", false);
    expect(emitterA(api).excludedChannels).toEqual([]);

    const vfx = api.scene.get().vfx.id;
    expect(() => api.timeline.setChannelExcluded(vfx, "position", true)).toThrow(/host code/);
    expect(() => api.timeline.setValueExcluded("emitter_a", "missing", true)).toThrow(/not_found/);
    expect(() => api.timeline.setValueExcluded("emitter_a", "glow", 1 as never)).toThrow(
      /invalid_argument/,
    );
  });

  it("plays an emitter's events in the editor only, keeping the events", () => {
    const store = twoEmitterStore();
    const api = withValues(store);
    const burst = api.timeline.addBurst("emitter_a", 0, 10);
    expect(emitterA(api).eventsExcluded).toBe(false);

    const before = store.getSource();
    api.timeline.setEventsExcluded("emitter_a", true);
    expect(emitterA(api).eventsExcluded).toBe(true);
    expect(emitterA(api).events.map((event) => event.id)).toContain(burst);
    store.undo();
    expect(store.getSource()).toBe(before);

    // Switched back off, the flag is dropped rather than stored as false (a byte-for-byte save).
    api.timeline.setEventsExcluded("emitter_a", true);
    api.timeline.setEventsExcluded("emitter_a", false);
    const doc = store.getSource().scene.emitters.find((emitter) => emitter.id === "emitter_a");
    expect(doc !== undefined && "liveEvents" in doc).toBe(false);

    const mesh = api.scene.addMesh();
    expect(() => api.timeline.setEventsExcluded(mesh, true)).toThrow(/only emitters/);
    expect(() => api.timeline.setEventsExcluded("emitter_a", "yes" as never)).toThrow(
      /invalid_argument.*excluded must be a boolean/,
    );
  });
});
