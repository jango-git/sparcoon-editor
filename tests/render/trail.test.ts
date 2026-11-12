import { FXWorld } from "sparcoon";
import type { FXEmitter } from "sparcoon/editor";
import type { Mesh, ShaderMaterial } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseGraphName, resolveGraph } from "../../src/agent/address.Internal";
import { createEditApi } from "../../src/agent/editApi";
import { readStatus } from "../../src/agent/status.Internal";
import { liveSession } from "../../src/agent/transaction.Internal";
import type { EditorGraph } from "../../src/domain/graphModel";
import {
  GraphKind,
  isTrailExcludedRenderNode,
  metaFor,
  readTrailSinkConfig,
  RENDER_CAST_SHADOW_PARAM,
  RENDER_SINK_ID,
  RENDER_SORT_INTERVAL_PARAM,
  SPAWN_EXPECTED_CAPACITY_PARAM,
  SPAWN_SINK_ID,
  TIMELINE_VALUE_TYPE,
  timelineValueConflicts,
  TRAIL_FRAMES_PARAM_KEY,
  TRAIL_INTERVAL_PARAM_KEY,
} from "../../src/domain/nodePalette";
import { trailAttributeErrors } from "../../src/domain/trailChecks";
import { resolveValueType } from "../../src/engine/core/socket/FXValueType";
import {
  addCatalogNode,
  connectSockets,
  setEmitterTrail,
  updateNodeParam,
} from "../../src/model/commands";
import {
  createDefaultEmitter,
  createDefaultTrailGraph,
  type EditorState,
  type EmitterDoc,
  emitterGraphs,
} from "../../src/model/editorState";
import { emitterEntity } from "../../src/model/entity";
import { Pipeline } from "../../src/model/pipeline";
import { SignalBus } from "../../src/model/signals";
import { Store } from "../../src/model/store";
import { compileEmitter } from "../../src/persistence/exportCompile";
import { emitProjectModule } from "../../src/persistence/exportTypeScript";
import { normalizeSource } from "../../src/persistence/loadState";
import { EmitterTrail } from "../../src/render/emitterTrail.Internal";
import type { SceneEmitters } from "../../src/render/sceneEmitters";
import { createPreview, destroyPreviews } from "../helpers/previewScene";
import { createTestState } from "../helpers/testDocument";

function setup(): { store: Store; emitters: SceneEmitters; emitterId: string } {
  const store = new Store(createTestState(), new SignalBus());
  return { store, emitters: createPreview(), emitterId: store.getSource().scene.emitters[0].id };
}

afterEach(() => {
  destroyPreviews();
  vi.restoreAllMocks();
});

function emitterDoc(store: Store): EmitterDoc {
  return store.getSource().scene.emitters[0];
}

function runtimeEmitter(emitters: SceneEmitters, id: string): FXEmitter {
  return emitters.entityObject(emitterEntity(id)) as FXEmitter;
}

function trailMaterial(emitter: FXEmitter): ShaderMaterial {
  const trail = (emitter as unknown as { trail: { mesh: Mesh } }).trail;
  return trail.mesh.material as ShaderMaterial;
}

/** The runtime emitter's particle material. */
function particleMaterial(emitter: FXEmitter): ShaderMaterial {
  return (emitter as unknown as { mesh: Mesh }).mesh.material as ShaderMaterial;
}

/** The runtime emitter's trail object (replaced by every trail swap), or `undefined`. */
function runtimeTrail(emitter: FXEmitter): unknown {
  return (emitter as unknown as { trail: unknown }).trail;
}

/** Wires `nodeId`'s `out` into the trail sink's ribbon `width`. */
function wireTrailWidth(store: Store, nodeId: string): void {
  connectSockets(
    store,
    "trailGraph",
    { nodeId, socketKey: "out" },
    { nodeId: RENDER_SINK_ID, socketKey: "width" },
  );
}

/** `emitter` with `graph` as its trail graph. */
function withTrail(emitter: EmitterDoc, graph: EditorGraph): EmitterDoc {
  return { ...emitter, trailGraph: graph };
}

/** Adds a float timeline value named `name` to `slot`'s graph and returns its node id. */
function addTimelineValue(
  store: Store,
  slot: "renderGraph" | "behaviorGraph" | "trailGraph",
  name: string,
  type = "float",
): string {
  const id = addCatalogNode(store, slot, TIMELINE_VALUE_TYPE, { x: 0, y: 0 });
  if (id === undefined) {
    throw new Error("timeline-value missing from the palette");
  }
  updateNodeParam(store, slot, id, "name", name);
  updateNodeParam(store, slot, id, "type", type);
  return id;
}

describe("emitter trail: document", () => {
  it("is off by default and turns on and off as an undoable edit", () => {
    const { store, emitterId } = setup();
    expect(emitterDoc(store).trailGraph).toBeUndefined();

    setEmitterTrail(store, emitterId, true);
    const trailGraph = emitterDoc(store).trailGraph;
    expect(trailGraph?.nodes[RENDER_SINK_ID]).toBeDefined();
    expect(trailGraph?.outputBindings.map((binding) => binding.slot)).toEqual(["albedo"]);
    expect(emitterGraphs(emitterDoc(store))).toHaveLength(3);

    setEmitterTrail(store, emitterId, false);
    expect(emitterDoc(store).trailGraph).toBeUndefined();
    store.undo();
    expect(emitterDoc(store).trailGraph).toEqual(trailGraph);
  });

  it("drops the trail's own timeline tracks with it, keeping a name another graph declares", () => {
    const { store, emitterId } = setup();
    setEmitterTrail(store, emitterId, true);
    addTimelineValue(store, "trailGraph", "fade");
    addTimelineValue(store, "trailGraph", "glow");
    addTimelineValue(store, "renderGraph", "glow");
    const withTracks: EditorState["source"] = {
      ...store.getSource(),
      scene: {
        ...store.getSource().scene,
        emitters: [
          {
            ...emitterDoc(store),
            tracks: [
              { name: "fade", keys: [] },
              { name: "glow", keys: [] },
            ],
          },
        ],
      },
    };
    store.commit(withTracks, "structural");
    setEmitterTrail(store, emitterId, false);
    expect(emitterDoc(store).tracks.map((track) => track.name)).toEqual(["glow"]);
  });

  it("round-trips through load, and an emitter saved without one stays without", () => {
    const { store, emitterId } = setup();
    const plain = normalizeSource(JSON.parse(JSON.stringify(store.getSource())));
    expect(plain?.scene.emitters[0].trailGraph).toBeUndefined();

    setEmitterTrail(store, emitterId, true);
    const loaded = normalizeSource(JSON.parse(JSON.stringify(store.getSource())));
    expect(loaded?.scene.emitters[0].trailGraph).toEqual(emitterDoc(store).trailGraph);
  });

  it("load drops trail bindings to the particle transforms and the sink's stale geometry", () => {
    const { store, emitterId } = setup();
    setEmitterTrail(store, emitterId, true);
    const trailGraph = emitterDoc(store).trailGraph;
    expect(trailGraph?.nodes[RENDER_SINK_ID]?.parameters).not.toHaveProperty("geometry");
    const raw = JSON.parse(JSON.stringify(store.getSource())) as {
      scene: { emitters: { trailGraph: EditorGraph }[] };
    };
    const rawTrail = raw.scene.emitters[0].trailGraph;
    const from = rawTrail.outputBindings[0].from;
    raw.scene.emitters[0].trailGraph = {
      ...rawTrail,
      nodes: {
        ...rawTrail.nodes,
        [RENDER_SINK_ID]: {
          ...rawTrail.nodes[RENDER_SINK_ID],
          parameters: { ...rawTrail.nodes[RENDER_SINK_ID].parameters, geometry: "box" },
        },
      },
      outputBindings: [
        ...rawTrail.outputBindings,
        { slot: "particleTransform", from },
        { slot: "vertexTransform", from },
      ],
    };
    const loaded = normalizeSource(raw)?.scene.emitters[0].trailGraph;
    expect(loaded?.outputBindings.map((binding) => binding.slot)).toEqual(["albedo"]);
    expect(loaded?.nodes[RENDER_SINK_ID]?.parameters).not.toHaveProperty("geometry");
  });

  it("refuses a graph edit aimed at a trail the emitter does not have", () => {
    const { store } = setup();
    const before = store.getSource();
    expect(() => addCatalogNode(store, "trailGraph", "constant", { x: 0, y: 0 })).toThrow(
      /no trail graph/,
    );
    expect(store.getSource()).toBe(before);
  });

  it("reads its history settings off the surface sink, clamped", () => {
    const { store, emitterId } = setup();
    setEmitterTrail(store, emitterId, true);
    updateNodeParam(store, "trailGraph", RENDER_SINK_ID, TRAIL_FRAMES_PARAM_KEY, 500);
    const trailGraph = emitterDoc(store).trailGraph;
    expect(trailGraph).toBeDefined();
    const config = readTrailSinkConfig(trailGraph as NonNullable<typeof trailGraph>);
    expect(config.frames).toBe(64);
    expect(config.sampleInterval).toBeGreaterThan(0);

    // Too short an interval clamps to the shortest offered, like too long a history does.
    updateNodeParam(store, "trailGraph", RENDER_SINK_ID, TRAIL_INTERVAL_PARAM_KEY, -1);
    const clamped = emitterDoc(store).trailGraph;
    expect(readTrailSinkConfig(clamped as NonNullable<typeof clamped>).sampleInterval).toBe(0.001);
  });

  it("keeps the nodes that read a surface normal out of a trail graph", () => {
    const lambert = metaFor(GraphKind.Render, "lambert-shading");
    const constant = metaFor(GraphKind.Render, "constant");
    expect(lambert !== undefined && isTrailExcludedRenderNode(lambert)).toBe(true);
    expect(constant !== undefined && isTrailExcludedRenderNode(constant)).toBe(false);
  });
});

describe("timeline values across an emitter's graphs", () => {
  it("flags one name declared at two types, attributed to the later declaration", () => {
    const { store, emitterId } = setup();
    setEmitterTrail(store, emitterId, true);
    addTimelineValue(store, "renderGraph", "glow", "float");
    const clash = addTimelineValue(store, "trailGraph", "glow", "vec3");
    const conflicts = timelineValueConflicts(emitterGraphs(emitterDoc(store)));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].graphIndex).toBe(2);
    expect(conflicts[0].error.nodeId).toBe(clash);
  });

  it("flags one name with two defaults in two graphs", () => {
    const { store, emitterId } = setup();
    setEmitterTrail(store, emitterId, true);
    const render = addTimelineValue(store, "renderGraph", "glow");
    updateNodeParam(store, "renderGraph", render, "value", 1);
    const trail = addTimelineValue(store, "trailGraph", "glow");
    updateNodeParam(store, "trailGraph", trail, "value", 0);
    const conflicts = timelineValueConflicts(emitterGraphs(emitterDoc(store)));
    expect(conflicts.map((conflict) => conflict.error.code)).toEqual(["param-value-conflict"]);
    updateNodeParam(store, "trailGraph", trail, "value", 1);
    expect(timelineValueConflicts(emitterGraphs(emitterDoc(store)))).toEqual([]);
  });

  it("treats a color as the vec4 it is", () => {
    const { store, emitterId } = setup();
    setEmitterTrail(store, emitterId, true);
    addTimelineValue(store, "renderGraph", "tint", "vec4");
    addTimelineValue(store, "trailGraph", "tint", "color");
    expect(timelineValueConflicts(emitterGraphs(emitterDoc(store)))).toEqual([]);
  });

  it("compares defaults as the engine reads them, at the type's width", () => {
    const cases: readonly [string, unknown, unknown][] = [
      // A fresh node's scalar 0 is a vec3's [0, 0, 0].
      ["vec3", 0, [0, 0, 0]],
      // A vec3 reads the first three components; the rest are dropped.
      ["vec3", [1, 2, 3], [1, 2, 3, 0]],
      ["float", 1, [1]],
    ];
    for (const [type, first, second] of cases) {
      const { store, emitterId } = setup();
      setEmitterTrail(store, emitterId, true);
      const render = addTimelineValue(store, "renderGraph", "glow", type);
      updateNodeParam(store, "renderGraph", render, "value", first);
      const trail = addTimelineValue(store, "trailGraph", "glow", type);
      updateNodeParam(store, "trailGraph", trail, "value", second);
      expect(timelineValueConflicts(emitterGraphs(emitterDoc(store))), type).toEqual([]);
    }
  });

  it("still flags two genuinely different vector defaults", () => {
    const { store, emitterId } = setup();
    setEmitterTrail(store, emitterId, true);
    const render = addTimelineValue(store, "renderGraph", "tint", "vec3");
    updateNodeParam(store, "renderGraph", render, "value", [1, 2, 3]);
    const trail = addTimelineValue(store, "trailGraph", "tint", "vec3");
    updateNodeParam(store, "trailGraph", trail, "value", [1, 2, 4]);
    const conflicts = timelineValueConflicts(emitterGraphs(emitterDoc(store)));
    expect(conflicts.map((conflict) => conflict.error.code)).toEqual(["param-value-conflict"]);
    expect(conflicts[0].error.nodeId).toBe(trail);
  });

  it("flags two defaults within one graph, on the later declaration", () => {
    const { store } = setup();
    const first = addTimelineValue(store, "renderGraph", "glow");
    updateNodeParam(store, "renderGraph", first, "value", 1);
    const second = addTimelineValue(store, "renderGraph", "glow");
    updateNodeParam(store, "renderGraph", second, "value", 2);
    const conflicts = timelineValueConflicts(emitterGraphs(emitterDoc(store)));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].graphIndex).toBe(0);
    expect(conflicts[0].error.nodeId).toBe(second);
  });

  it("refuses to export an emitter whose value has two defaults", () => {
    const { store, emitterId } = setup();
    setEmitterTrail(store, emitterId, true);
    const render = addTimelineValue(store, "renderGraph", "glow");
    updateNodeParam(store, "renderGraph", render, "value", 1);
    addTimelineValue(store, "trailGraph", "glow");
    expect(() => emitProjectModule(store.getSource())).toThrow(/different default/);
  });

  it("holds the preview on a clash", () => {
    const { store, emitters, emitterId } = setup();
    setEmitterTrail(store, emitterId, true);
    addTimelineValue(store, "renderGraph", "glow", "float");
    addTimelineValue(store, "trailGraph", "glow", "vec2");
    const result = emitters.sync(store.getSource().scene);
    expect(result.trailStatus?.status).toBe("invalid");
    expect(result.renderStatus.status).toBe("invalid");
  });
});

describe("emitter trail: live preview", () => {
  it("builds the runtime trail, swaps it without a rebuild, and removes it", () => {
    const { store, emitters, emitterId } = setup();
    emitters.sync(store.getSource().scene);
    emitters.spawn(emitterId, { kind: "burst", count: 8 });
    FXWorld.update(0); // births land in a tick; a paused one seeds without simulating

    setEmitterTrail(store, emitterId, true);
    const on = emitters.sync(store.getSource().scene);
    expect(on.trailStatus?.status).toBe("recompiled");
    expect(on.recompiled).not.toBe(true);
    expect(runtimeEmitter(emitters, emitterId).hasTrail).toBe(true);
    expect(emitters.totalParticleCount()).toBe(8);

    setEmitterTrail(store, emitterId, false);
    const off = emitters.sync(store.getSource().scene);
    expect(off.trailStatus).toBeUndefined();
    expect(runtimeEmitter(emitters, emitterId).hasTrail).toBe(false);
    expect(emitters.totalParticleCount()).toBe(8);
  });

  it("refuses a trail on a depth-sorted emitter", () => {
    const { store, emitters, emitterId } = setup();
    setEmitterTrail(store, emitterId, true);
    updateNodeParam(store, "renderGraph", RENDER_SINK_ID, RENDER_SORT_INTERVAL_PARAM, 2);
    const result = emitters.sync(store.getSource().scene);
    expect(result.trailStatus?.status).toBe("invalid");
    expect(result.trailStatus?.messages[0]).toMatch(/depth sorting/);
    // The fix is the render graph's Sort Every, so the error is pinned on its surface sink.
    expect(result.renderStatus.errors?.[0]?.nodeId).toBe(RENDER_SINK_ID);
  });

  it("clears the trail's status once the emitter has no trail", () => {
    const { store, emitters, emitterId } = setup();
    const pipeline = new Pipeline(store, emitters);
    setEmitterTrail(store, emitterId, true);
    updateNodeParam(store, "renderGraph", RENDER_SINK_ID, RENDER_SORT_INTERVAL_PARAM, 2);
    pipeline.recomputeNow();
    expect(store.getState().derived.trailStatus?.status).toBe("invalid");
    setEmitterTrail(store, emitterId, false);
    pipeline.recomputeNow();
    expect(store.getState().derived.trailStatus).toBeUndefined();
    expect(store.getState().derived.trailSnapshot).toBeUndefined();
  });

  it("drives a value both graphs declare into both materials", () => {
    const { store, emitters, emitterId } = setup();
    setEmitterTrail(store, emitterId, true);
    // Each wired into a sink so the value reaches its shader (an unread value compiles out).
    const trailValue = addTimelineValue(store, "trailGraph", "glow");
    wireTrailWidth(store, trailValue);
    const renderValue = addTimelineValue(store, "renderGraph", "glow");
    connectSockets(
      store,
      "renderGraph",
      { nodeId: renderValue, socketKey: "out" },
      { nodeId: RENDER_SINK_ID, socketKey: "additivity" },
    );
    emitters.sync(store.getSource().scene);
    emitters.driveParamValues(emitterId, new Map([["glow", 0.5]]));
    const emitter = runtimeEmitter(emitters, emitterId);
    expect(trailMaterial(emitter).uniforms["u_param_glow"].value).toBe(0.5);
    expect(particleMaterial(emitter).uniforms["u_param_glow"].value).toBe(0.5);
  });

  it("rebinds a trail value edited in the same sync as a render swap", () => {
    const { store, emitters, emitterId } = setup();
    setEmitterTrail(store, emitterId, true);
    const trailValue = addTimelineValue(store, "trailGraph", "glow");
    wireTrailWidth(store, trailValue);
    emitters.sync(store.getSource().scene);
    const emitter = runtimeEmitter(emitters, emitterId);

    // A value-only trail edit and a render-structural one (a shadow flag) in one sync.
    updateNodeParam(store, "trailGraph", trailValue, "value", 0.7);
    updateNodeParam(store, "renderGraph", RENDER_SINK_ID, RENDER_CAST_SHADOW_PARAM, true);
    const result = emitters.sync(store.getSource().scene);
    expect(result.renderStatus.status).toBe("recompiled");
    expect(result.trailStatus?.status).toBe("rebound");
    expect(result.recompiled).not.toBe(true);
    expect(runtimeEmitter(emitters, emitterId)).toBe(emitter);
    expect(trailMaterial(emitter).uniforms["u_param_glow"].value).toBe(0.7);
  });

  it("swaps the trail in place on a trail-graph structural edit", () => {
    const { store, emitters, emitterId } = setup();
    setEmitterTrail(store, emitterId, true);
    emitters.sync(store.getSource().scene);
    emitters.spawn(emitterId, { kind: "burst", count: 8 });
    FXWorld.update(0); // births land in a tick; a paused one seeds without simulating
    const emitter = runtimeEmitter(emitters, emitterId);
    const before = runtimeTrail(emitter);

    const width = addCatalogNode(store, "trailGraph", "constant", { x: 0, y: 0 });
    wireTrailWidth(store, width ?? "");
    const result = emitters.sync(store.getSource().scene);
    expect(result.trailStatus?.status).toBe("recompiled");
    expect(result.renderStatus.status).toBe("rebound");
    expect(result.recompiled).not.toBe(true);
    expect(runtimeEmitter(emitters, emitterId)).toBe(emitter);
    expect(runtimeTrail(emitter)).not.toBe(before);
    expect(emitters.totalParticleCount()).toBe(8);
  });

  it("swaps the trail in place when its history length or interval changes", () => {
    const { store, emitters, emitterId } = setup();
    setEmitterTrail(store, emitterId, true);
    emitters.sync(store.getSource().scene);
    emitters.spawn(emitterId, { kind: "burst", count: 8 });
    FXWorld.update(0); // births land in a tick; a paused one seeds without simulating
    const emitter = runtimeEmitter(emitters, emitterId);

    for (const [key, value] of [
      [TRAIL_FRAMES_PARAM_KEY, 32],
      [TRAIL_INTERVAL_PARAM_KEY, 0.05],
    ] as const) {
      const before = runtimeTrail(emitter);
      updateNodeParam(store, "trailGraph", RENDER_SINK_ID, key, value);
      const result = emitters.sync(store.getSource().scene);
      expect(result.trailStatus?.status, key).toBe("recompiled");
      expect(result.recompiled, key).not.toBe(true);
      expect(runtimeTrail(emitter), key).not.toBe(before);
    }
    expect(runtimeEmitter(emitters, emitterId)).toBe(emitter);
    expect(emitters.totalParticleCount()).toBe(8);
  });

  it("keeps the trail through a behavior-structural rebuild", () => {
    const { store, emitters, emitterId } = setup();
    setEmitterTrail(store, emitterId, true);
    emitters.sync(store.getSource().scene);
    const emitter = runtimeEmitter(emitters, emitterId);

    updateNodeParam(store, "behaviorGraph", SPAWN_SINK_ID, SPAWN_EXPECTED_CAPACITY_PARAM, 64);
    const result = emitters.sync(store.getSource().scene);
    expect(result.recompiled).toBe(true);
    expect(result.trailStatus?.status).toBe("recompiled");
    const rebuilt = runtimeEmitter(emitters, emitterId);
    expect(rebuilt).not.toBe(emitter);
    expect(rebuilt.hasTrail).toBe(true);

    // Nothing changed since: the rebuilt emitter's trail is current, so the next sync only rebinds.
    expect(emitters.sync(store.getSource().scene).trailStatus?.status).toBe("rebound");
  });

  it("disposes the trail's live graph with the emitter view", () => {
    const { store, emitters, emitterId } = setup();
    setEmitterTrail(store, emitterId, true);
    emitters.sync(store.getSource().scene);
    const destroy = vi.spyOn(EmitterTrail.prototype, "destroy");
    emitters.destroy();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

describe("emitter trail: export", () => {
  it("exports the trail's artifacts per tier and its history on the emitter spec", () => {
    const { store, emitterId } = setup();
    setEmitterTrail(store, emitterId, true);
    const text = emitProjectModule(store.getSource());
    const { frames, sampleInterval } = readTrailSinkConfig(emitterDoc(store).trailGraph!);
    expect(text).toContain("const trail0Baseline: FXRenderArtifact");
    expect(text).toContain("const trail0Standard: FXRenderArtifact");
    expect(text).toContain(
      `trail: { render: { baseline: trail0Baseline, standard: trail0Standard }, frames: ${String(frames)}, sampleInterval: ${String(sampleInterval)} },`,
    );
  });

  it("leaves an emitter without a trail exactly as before", () => {
    const { store } = setup();
    expect(emitProjectModule(store.getSource())).not.toContain("trail");
  });

  it("lists a texture only the trail samples among the emitter's external slots", () => {
    const { store, emitterId } = setup();
    setEmitterTrail(store, emitterId, true);
    const texture = addCatalogNode(store, "trailGraph", "texture", { x: 0, y: 0 });
    updateNodeParam(store, "trailGraph", texture ?? "", "name", "spark");
    connectSockets(
      store,
      "trailGraph",
      { nodeId: texture ?? "", socketKey: "color" },
      { nodeId: RENDER_SINK_ID, socketKey: "albedo" },
    );
    expect(emitProjectModule(store.getSource())).toContain('externalSlots: ["spark"]');
  });

  it("tapers the width along the trail from the same uv read that colours it", () => {
    const { store, emitterId } = setup();
    setEmitterTrail(store, emitterId, true);
    const uv = addCatalogNode(store, "trailGraph", "uv", { x: 0, y: 0 }) ?? "";
    const along = addCatalogNode(store, "trailGraph", "split", { x: 0, y: 0 }) ?? "";
    const texture = addCatalogNode(store, "trailGraph", "texture", { x: 0, y: 0 }) ?? "";
    const wire = (from: string, out: string, to: string, input: string): void =>
      connectSockets(
        store,
        "trailGraph",
        { nodeId: from, socketKey: out },
        { nodeId: to, socketKey: input },
      );
    wire(uv, "uv", along, "v");
    wire(along, "x", RENDER_SINK_ID, "width"); // vertex
    wire(uv, "uv", texture, "uv"); // fragment
    wire(texture, "color", RENDER_SINK_ID, "albedo");
    expect(() => compileEmitter(emitterDoc(store))).not.toThrow();
  });

  it("refuses to export a trail whose material some WebGL2 GPU could not link", () => {
    // Five vec4 attributes the trail reads: within WebGL2's vertex attributes over the JS history,
    // past them over the GPU one - so only an emitter with a GPU kernel is refused.
    const heavy = emitterWithTrailReading(5);
    expect(() => compileEmitter(heavy)).toThrow(/\(trail\).*vertex attributes; every WebGL2 GPU/);
    const jsOnly: EmitterDoc = {
      ...heavy,
      behaviorGraph: {
        ...heavy.behaviorGraph,
        nodes: {
          ...heavy.behaviorGraph.nodes,
          [SPAWN_SINK_ID]: {
            ...heavy.behaviorGraph.nodes[SPAWN_SINK_ID],
            parameters: { tryGpuSimulation: false },
          },
        },
      },
    };
    expect(() => compileEmitter(jsOnly)).not.toThrow();
  });

  it("refuses to export a trail reading an attribute at another width or undeclared", () => {
    const heavy = emitterWithTrailReading(1);
    const trailGraph = heavy.trailGraph as EditorGraph;
    const retyped = (parameters: Record<string, unknown>): EmitterDoc =>
      withTrail(heavy, {
        ...trailGraph,
        nodes: {
          ...trailGraph.nodes,
          ["r_a0"]: { ...trailGraph.nodes["r_a0"], parameters },
        },
      });
    expect(() => compileEmitter(heavy)).not.toThrow();
    expect(() => compileEmitter(retyped({ name: "a0", type: "vec2" }))).toThrow(
      /\(trail\): attribute "a0" is requested as both/,
    );
    expect(() => compileEmitter(retyped({ name: "ghost", type: "vec4" }))).toThrow(
      /\(trail\): attribute "ghost" is not declared/,
    );
  });

  it("refuses to export a trail on a depth-sorted emitter", () => {
    const { store, emitterId } = setup();
    setEmitterTrail(store, emitterId, true);
    updateNodeParam(store, "renderGraph", RENDER_SINK_ID, RENDER_SORT_INTERVAL_PARAM, 3);
    expect(() => emitProjectModule(store.getSource())).toThrow(/depth sorting/);
  });
});

describe("trail attribute checks", () => {
  const vec = (name: string, type: "vec2" | "vec3") => ({ name, type: resolveValueType(type) });

  it("accepts a read the behavior writes at the same width and the emitter declares", () => {
    expect(
      trailAttributeErrors(
        [vec("heat", "vec3")],
        [vec("heat", "vec3")],
        [{ name: "heat", type: "vec3" }],
      ),
    ).toEqual([]);
  });

  it("flags a read at another width than the behavior writes", () => {
    const errors = trailAttributeErrors(
      [vec("heat", "vec2")],
      [vec("heat", "vec3")],
      [{ name: "heat", type: "vec3" }],
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it("flags a read of an attribute the emitter does not declare", () => {
    const errors = trailAttributeErrors([vec("ghost", "vec3")], [], []);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("agent API: trail graphs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names the trail graph, and refuses it on an emitter without one", () => {
    const { store, emitterId } = setup();
    expect(parseGraphName("trail")).toBe("trail");
    expect(() => parseGraphName("ribbon")).toThrow(/invalid_argument/);
    expect(() => resolveGraph(store.getSource(), emitterId, "trail")).toThrow(/no trail/);
    setEmitterTrail(store, emitterId, true);
    const target = resolveGraph(store.getSource(), emitterId, "trail");
    expect(target.slot).toBe("trailGraph");
    expect(target.kind).toBe(GraphKind.Render);
    expect(target.host).toBe("trail");
  });

  it("refuses a surface-normal node on the trail host", () => {
    const { store, emitterId } = setup();
    setEmitterTrail(store, emitterId, true);
    const graph = createEditApi(liveSession(store)).graph(emitterId, "trail");
    expect(() => graph.addNode("lambert-shading")).toThrow(/invalid_argument/);
    expect(() => graph.addNode("constant")).not.toThrow();
  });

  it("reports the trail's status only while the emitter has one", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback): number => {
      setTimeout(() => callback(0), 0);
      return 0;
    });
    const { store } = setup();
    expect((await readStatus(store)).trail).toBeUndefined();
    store.setDerived({ trailStatus: { status: "invalid", messages: ["broken"] } });
    expect((await readStatus(store)).trail?.status).toBe("invalid");
  });
});

/**
 * The starter emitter with a trail reading `count` vec4 behavior attributes, summed into its
 * albedo in the fragment stage - every read reachable.
 */
function emitterWithTrailReading(count: number): EmitterDoc {
  const emitter = createDefaultEmitter("emitter_1", "Heavy");
  const names = Array.from({ length: count }, (_, index) => `a${String(index)}`);
  const behavior = emitter.behaviorGraph;
  const trail = createDefaultTrailGraph();
  const reads = Object.fromEntries(
    names.map((name, index) => [
      `r_${name}`,
      {
        id: `r_${name}`,
        type: "custom-attribute",
        parameters: { name, type: "vec4" },
        position: { x: 0, y: index * 80 },
      },
    ]),
  );
  const sums = Object.fromEntries(
    names.slice(1).map((_name, index) => [
      `sum_${String(index)}`,
      {
        id: `sum_${String(index)}`,
        type: "binary-op",
        parameters: { op: "add" },
        position: { x: 200, y: index * 80 },
      },
    ]),
  );
  return withTrail(
    {
      ...emitter,
      behaviorGraph: {
        ...behavior,
        attributes: names.map((name) => ({ name, type: "vec4" })),
        nodes: {
          ...behavior.nodes,
          ...Object.fromEntries(
            names.map((name, index) => [
              `w_${name}`,
              {
                id: `w_${name}`,
                type: "constant",
                parameters: { type: "vec4", value: [index, 0, 0, 1] },
                position: { x: 0, y: index * 80 },
              },
            ]),
          ),
        },
        outputBindings: [
          ...behavior.outputBindings,
          ...names.map((name) => ({
            slot: `attr:${name}`,
            from: { nodeId: `w_${name}`, socketKey: "out" },
            phase: "spawn" as const,
          })),
        ],
      },
    },
    {
      ...trail,
      nodes: { ...trail.nodes, ...reads, ...sums },
      connections: names.slice(1).flatMap((name, index) => [
        {
          id: `ca_${String(index)}`,
          from: {
            nodeId: index === 0 ? `r_${names[0]}` : `sum_${String(index - 1)}`,
            socketKey: index === 0 ? "value" : "out",
          },
          to: { nodeId: `sum_${String(index)}`, socketKey: "a" },
        },
        {
          id: `cb_${String(index)}`,
          from: { nodeId: `r_${name}`, socketKey: "value" },
          to: { nodeId: `sum_${String(index)}`, socketKey: "b" },
        },
      ]),
      outputBindings: [
        {
          slot: "albedo",
          from:
            names.length === 1
              ? { nodeId: `r_${names[0]}`, socketKey: "value" }
              : { nodeId: `sum_${String(names.length - 2)}`, socketKey: "out" },
        },
      ],
    },
  );
}
