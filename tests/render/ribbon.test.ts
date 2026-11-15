import { FXWorld } from "sparcoon";
import type { FXEmitter } from "sparcoon/editor";
import type { Mesh, ShaderMaterial } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveGraph } from "../../src/agent/address.Internal";
import { createEditApi } from "../../src/agent/editApi";
import { liveSession } from "../../src/agent/transaction.Internal";
import {
  readRenderSinkConfig,
  readRibbonSinkConfig,
  RENDER_DRAW_PARTICLES_PARAM,
  RENDER_SINK_ID,
  RENDER_SINK_TYPE,
  RENDER_SORT_INTERVAL_PARAM,
  RIBBON_HEAD_PARAM_KEY,
  RIBBON_TILE_PARAM_KEY,
  RIBBON_UV_PARAM_KEY,
  sinkMeta,
} from "../../src/domain/nodePalette";
import { emitterDrawsNothingWarnings, stripSpawnWarnings } from "../../src/domain/stripChecks";
import { setEmitterStrip, updateNodeParam } from "../../src/model/commands";
import type { EmitterDoc } from "../../src/model/editorState";
import { emitterEntity } from "../../src/model/entity";
import { Store } from "../../src/model/store";
import { compileEmitter } from "../../src/persistence/exportCompile";
import { emitProjectModule } from "../../src/persistence/exportTypeScript";
import { normalizeSource } from "../../src/persistence/loadState";
import type { SceneEmitters } from "../../src/render/sceneEmitters";
import { createPreview, destroyPreviews } from "../helpers/previewScene";
import { createTestState } from "../helpers/testDocument";

function setup(): { store: Store; emitters: SceneEmitters; emitterId: string } {
  const store = new Store(createTestState());
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

function ribbonMaterial(emitter: FXEmitter): ShaderMaterial {
  const ribbon = (emitter as unknown as { strips: { strips: { ribbon: { mesh: Mesh } } } }).strips
    .strips.ribbon;
  return ribbon.mesh.material as ShaderMaterial;
}

function particleMesh(emitter: FXEmitter): Mesh {
  return (emitter as unknown as { mesh: Mesh }).mesh;
}

describe("emitter ribbon: document", () => {
  it("is off by default, turns on beside a trail, and round-trips through load", () => {
    const { store, emitterId } = setup();
    expect(emitterDoc(store).ribbonGraph).toBeUndefined();
    setEmitterStrip(store, emitterId, "trail", true);
    setEmitterStrip(store, emitterId, "ribbon", true);
    const ribbonGraph = emitterDoc(store).ribbonGraph;
    expect(ribbonGraph?.outputBindings.map((binding) => binding.slot)).toEqual(["albedo"]);
    expect(emitterDoc(store).trailGraph).toBeDefined();
    const loaded = normalizeSource(JSON.parse(JSON.stringify(store.getSource())));
    expect(loaded?.scene.emitters[0].ribbonGraph).toEqual(ribbonGraph);
    setEmitterStrip(store, emitterId, "ribbon", false);
    expect(emitterDoc(store).ribbonGraph).toBeUndefined();
    expect(emitterDoc(store).trailGraph).toBeDefined();
    store.undo();
    expect(emitterDoc(store).ribbonGraph).toEqual(ribbonGraph);
  });

  it("reads its UV off the surface sink: stretch by default, a whole tile of at least 1", () => {
    const { store, emitterId } = setup();
    setEmitterStrip(store, emitterId, "ribbon", true);
    const graph = (): NonNullable<EmitterDoc["ribbonGraph"]> => {
      const ribbon = emitterDoc(store).ribbonGraph;
      if (ribbon === undefined) {
        throw new Error("no ribbon");
      }
      return ribbon;
    };
    expect(readRibbonSinkConfig(graph()).uv).toEqual({ mode: "stretch" });
    updateNodeParam(store, "ribbonGraph", RENDER_SINK_ID, RIBBON_UV_PARAM_KEY, "tile");
    updateNodeParam(store, "ribbonGraph", RENDER_SINK_ID, RIBBON_TILE_PARAM_KEY, 2.7);
    expect(readRibbonSinkConfig(graph()).uv).toEqual({ mode: "tile", particles: 2 });
    updateNodeParam(store, "ribbonGraph", RENDER_SINK_ID, RIBBON_TILE_PARAM_KEY, -3);
    expect(readRibbonSinkConfig(graph()).uv).toEqual({ mode: "tile", particles: 1 });
  });

  it("offers Draw Particles on an emitter's render sink only, on by default", () => {
    const { store } = setup();
    expect(readRenderSinkConfig(emitterDoc(store).renderGraph).drawParticles).toBe(true);
    const particleParams = Object.keys(sinkMeta(RENDER_SINK_TYPE).params);
    expect(particleParams).toContain(RENDER_DRAW_PARTICLES_PARAM);
    const meshParams = Object.keys(sinkMeta(RENDER_SINK_TYPE, { renderHost: "mesh" }).params);
    expect(meshParams).not.toContain(RENDER_DRAW_PARTICLES_PARAM);
    const ribbonParams = Object.keys(sinkMeta(RENDER_SINK_TYPE, { renderHost: "ribbon" }).params);
    expect(ribbonParams).toEqual([
      "renderMode",
      RIBBON_UV_PARAM_KEY,
      RIBBON_TILE_PARAM_KEY,
      RIBBON_HEAD_PARAM_KEY,
    ]);
  });

  it("warns when bursts of several particles or reactions would weave the ribbon", () => {
    const { store, emitterId } = setup();
    setEmitterStrip(store, emitterId, "ribbon", true);
    const emitter = emitterDoc(store);
    const play: EmitterDoc = {
      ...emitter,
      events: [{ id: "e1", time: 0, kind: "play", rate: 30, duration: 1 }],
    };
    expect(stripSpawnWarnings("ribbon", play)).toEqual([]);
    const burst: EmitterDoc = {
      ...emitter,
      events: [{ id: "e1", time: 0, kind: "burst", count: 5 }],
    };
    expect(stripSpawnWarnings("ribbon", burst).map((warning) => warning.code)).toEqual([
      "ribbon-interleaved-births",
    ]);
    const { ribbonGraph, ...withoutRibbon } = burst;
    expect(ribbonGraph).toBeDefined();
    expect(stripSpawnWarnings("ribbon", withoutRibbon)).toEqual([]);
  });

  it("reads its Head off the surface sink, off by default, and warns when no play shows it", () => {
    const { store, emitterId } = setup();
    setEmitterStrip(store, emitterId, "ribbon", true);
    const ribbonGraph = (): NonNullable<EmitterDoc["ribbonGraph"]> => {
      const graph = emitterDoc(store).ribbonGraph;
      if (graph === undefined) {
        throw new Error("no ribbon graph");
      }
      return graph;
    };
    expect(readRibbonSinkConfig(ribbonGraph()).head).toBe(false);
    updateNodeParam(store, "ribbonGraph", RENDER_SINK_ID, RIBBON_HEAD_PARAM_KEY, true);
    expect(readRibbonSinkConfig(ribbonGraph()).head).toBe(true);
    const emitter = emitterDoc(store);
    const play: EmitterDoc = {
      ...emitter,
      events: [{ id: "e1", time: 0, kind: "play", rate: 30, duration: 1 }],
    };
    expect(stripSpawnWarnings("ribbon", play)).toEqual([]);
    const burst: EmitterDoc = {
      ...emitter,
      events: [{ id: "e1", time: 0, kind: "burst", count: 1 }],
    };
    expect(stripSpawnWarnings("ribbon", burst)).toMatchObject([
      { code: "ribbon-head-without-play", nodeId: RENDER_SINK_ID },
    ]);
  });

  it("warns on an emitter that draws nothing", () => {
    const { store, emitterId } = setup();
    updateNodeParam(store, "renderGraph", RENDER_SINK_ID, RENDER_DRAW_PARTICLES_PARAM, false);
    expect(emitterDrawsNothingWarnings(emitterDoc(store)).map((each) => each.code)).toEqual([
      "emitter-draws-nothing",
    ]);
    setEmitterStrip(store, emitterId, "ribbon", true);
    expect(emitterDrawsNothingWarnings(emitterDoc(store))).toEqual([]);
  });
});

describe("emitter ribbon: live preview", () => {
  it("builds the runtime ribbon, swaps it on a UV change without a rebuild, and removes it", () => {
    const { store, emitters, emitterId } = setup();
    emitters.sync(store.getSource().scene);
    emitters.spawn(emitterId, { kind: "burst", count: 8 });
    FXWorld.update(0);

    setEmitterStrip(store, emitterId, "ribbon", true);
    const on = emitters.sync(store.getSource().scene);
    expect(on.strips?.ribbon?.status.status).toBe("recompiled");
    expect(on.recompiled).not.toBe(true);
    expect(runtimeEmitter(emitters, emitterId).hasStrip("ribbon")).toBe(true);
    expect(emitters.totalParticleCount()).toBe(8);
    // The test document's timeline bursts 32 particles at once: warned, still drawn.
    expect(on.strips?.ribbon?.status.warnings).toHaveLength(1);

    updateNodeParam(store, "ribbonGraph", RENDER_SINK_ID, RIBBON_UV_PARAM_KEY, "tile");
    const tiled = emitters.sync(store.getSource().scene);
    expect(tiled.strips?.ribbon?.status.status).toBe("recompiled");
    expect(ribbonMaterial(runtimeEmitter(emitters, emitterId)).uniforms["u_ribbonTile"].value).toBe(
      4,
    );
    expect(emitters.totalParticleCount()).toBe(8);

    const ribbonPoints = (): { probe?: unknown } =>
      (
        runtimeEmitter(emitters, emitterId) as unknown as {
          strips: { strips: { ribbon: { points: { probe?: unknown } } } };
        }
      ).strips.strips.ribbon.points;
    expect(ribbonPoints().probe).toBeUndefined();
    updateNodeParam(store, "ribbonGraph", RENDER_SINK_ID, RIBBON_HEAD_PARAM_KEY, true);
    const headed = emitters.sync(store.getSource().scene);
    expect(headed.strips?.ribbon?.status.status).toBe("recompiled");
    expect(ribbonPoints().probe).toBeDefined();
    expect(emitters.totalParticleCount()).toBe(8);

    setEmitterStrip(store, emitterId, "ribbon", false);
    const off = emitters.sync(store.getSource().scene);
    expect(off.strips?.ribbon?.status).toBeUndefined();
    expect(runtimeEmitter(emitters, emitterId).hasStrip("ribbon")).toBe(false);
  });

  it("refuses a ribbon on a depth-sorted emitter, pinned on the render sink", () => {
    const { store, emitters, emitterId } = setup();
    setEmitterStrip(store, emitterId, "ribbon", true);
    updateNodeParam(store, "renderGraph", RENDER_SINK_ID, RENDER_SORT_INTERVAL_PARAM, 2);
    const result = emitters.sync(store.getSource().scene);
    expect(result.strips?.ribbon?.status.status).toBe("invalid");
    expect(result.strips?.ribbon?.status.messages[0]).toMatch(/depth sorting/);
    expect(result.renderStatus.errors?.[0]?.nodeId).toBe(RENDER_SINK_ID);
  });

  it("stops and starts drawing the particles in place with Draw Particles", () => {
    const { store, emitters, emitterId } = setup();
    setEmitterStrip(store, emitterId, "ribbon", true);
    emitters.sync(store.getSource().scene);
    emitters.spawn(emitterId, { kind: "burst", count: 3 });
    FXWorld.update(0);

    updateNodeParam(store, "renderGraph", RENDER_SINK_ID, RENDER_DRAW_PARTICLES_PARAM, false);
    const hidden = emitters.sync(store.getSource().scene);
    expect(hidden.renderStatus.status).toBe("recompiled");
    expect(hidden.recompiled).not.toBe(true);
    const emitter = runtimeEmitter(emitters, emitterId);
    expect(emitter.drawsParticles).toBe(false);
    expect(particleMesh(emitter).visible).toBe(false);
    expect(emitters.totalParticleCount()).toBe(3);

    updateNodeParam(store, "renderGraph", RENDER_SINK_ID, RENDER_DRAW_PARTICLES_PARAM, true);
    emitters.sync(store.getSource().scene);
    expect(runtimeEmitter(emitters, emitterId).drawsParticles).toBe(true);
    expect(emitters.totalParticleCount()).toBe(3);
  });

  it("refuses to sort particles it does not draw", () => {
    const { store, emitters } = setup();
    updateNodeParam(store, "renderGraph", RENDER_SINK_ID, RENDER_DRAW_PARTICLES_PARAM, false);
    updateNodeParam(store, "renderGraph", RENDER_SINK_ID, RENDER_SORT_INTERVAL_PARAM, 2);
    const result = emitters.sync(store.getSource().scene);
    expect(result.renderStatus.status).toBe("invalid");
    expect(result.renderStatus.errors?.[0]?.code).toBe("sort-without-particles");
  });
});

describe("emitter ribbon: export and agent API", () => {
  it("ships the ribbon with its UV and Head, and no render artifact for particles it does not draw", () => {
    const { store, emitterId } = setup();
    setEmitterStrip(store, emitterId, "ribbon", true);
    updateNodeParam(store, "ribbonGraph", RENDER_SINK_ID, RIBBON_UV_PARAM_KEY, "tile");
    updateNodeParam(store, "ribbonGraph", RENDER_SINK_ID, RIBBON_TILE_PARAM_KEY, 3);
    updateNodeParam(store, "ribbonGraph", RENDER_SINK_ID, RIBBON_HEAD_PARAM_KEY, true);
    updateNodeParam(store, "renderGraph", RENDER_SINK_ID, RENDER_DRAW_PARTICLES_PARAM, false);
    const ir = compileEmitter(emitterDoc(store));
    expect(ir.drawParticles).toBe(false);
    expect(ir.ribbon?.fields).toEqual({ uv: { mode: "tile", particles: 3 }, head: true });
    const module = emitProjectModule(store.getSource());
    expect(module).toContain(
      'ribbon: { render: { baseline: ribbon0Baseline, standard: ribbon0Standard }, uv: {"mode":"tile","particles":3}, head: true },',
    );
    expect(module).not.toMatch(/^ {6}render: /m);
  });

  it("refuses to export a hidden emitter that sorts", () => {
    const { store } = setup();
    updateNodeParam(store, "renderGraph", RENDER_SINK_ID, RENDER_DRAW_PARTICLES_PARAM, false);
    updateNodeParam(store, "renderGraph", RENDER_SINK_ID, RENDER_SORT_INTERVAL_PARAM, 2);
    expect(() => compileEmitter(emitterDoc(store))).toThrow(/cannot sort/);
  });

  it("turns the ribbon on and names its graph", () => {
    const { store, emitterId } = setup();
    expect(() => resolveGraph(store.getSource(), emitterId, "ribbon")).toThrow(/scene\.setRibbon/);
    const api = createEditApi(liveSession(store));
    api.scene.setRibbon(emitterId, true);
    expect(api.scene.get().emitters[0].ribbon).toBe(true);
    const target = resolveGraph(store.getSource(), emitterId, "ribbon");
    expect(target).toMatchObject({ slot: "ribbonGraph", host: "ribbon" });
    const graph = api.graph(emitterId, "ribbon");
    expect(() => graph.addNode("lambert-shading")).toThrow(/a ribbon does not have/);
    expect(() => graph.addNode("constant")).not.toThrow();
  });
});
