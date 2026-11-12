import { FXWorld } from "sparcoon";
import { afterEach, describe, expect, it } from "vitest";

import {
  SPAWN_EXPECTED_CAPACITY_PARAM,
  SPAWN_SINK_ID,
  SPAWN_TRY_GPU_SIMULATION_PARAM,
} from "../../src/domain/nodePalette";
import { updateNodeParam } from "../../src/model/commands";
import { SignalBus } from "../../src/model/signals";
import { Store } from "../../src/model/store";
import { createPreview, destroyPreviews } from "../helpers/previewScene";
import { createTestState } from "../helpers/testDocument";

afterEach(destroyPreviews);

// A burst through the real live-preview construction path (EmitterView -> FXEmitter.fromArtifacts
// via "sparcoon/editor"), end to end.
describe("SceneEmitters: emitter burst through the live-preview path", () => {
  it("burst on the default emitter spawns particles and they survive FXWorld ticks", () => {
    const store = new Store(createTestState(), new SignalBus());
    // The default emitter has "Try GPU simulation" on by default, but the stub claims WebGL1 -
    // installEmitter's isWebGL2 gate keeps the compiled program unused, falling back to the JS driver.
    const emitters = createPreview();
    const source = store.getSource();
    emitters.sync(source.scene);
    const emitterId = source.scene.emitters[0].id;

    emitters.spawn(emitterId, { kind: "burst", count: 32 });
    FXWorld.update(0); // births land in a tick; a paused one seeds without simulating
    expect(emitters.totalParticleCount()).toBe(32);

    for (let i = 0; i < 30; i += 1) {
      FXWorld.update(1 / 60);
    }
    expect(emitters.totalParticleCount()).toBe(32);
  });

  it('burst still works with "Try GPU simulation" on, degrading to the JS driver in this headless suite', () => {
    const store = new Store(createTestState(), new SignalBus());
    // Claims WebGL2 so EmitterView.installEmitter actually wires the compiled standard-family
    // program through as gpuKernel - but it is not a real WebGL2 context, so FXEmitter.
    // fromArtifacts's own driver construction still falls back to the JS driver (FXEmitter.ts's
    // try/catch around `new FXGPUEmitterDriver`), exactly as it would on a real device whose
    // WebGL2 implementation rejects the compiled program at runtime.
    const emitters = createPreview({ webgl2: true });
    const emitterId = store.getSource().scene.emitters[0].id;
    updateNodeParam(store, "behaviorGraph", SPAWN_SINK_ID, SPAWN_TRY_GPU_SIMULATION_PARAM, true);

    expect(() => emitters.sync(store.getSource().scene)).not.toThrow();
    emitters.spawn(emitterId, { kind: "burst", count: 32 });
    FXWorld.update(0); // births land in a tick; a paused one seeds without simulating
    expect(emitters.totalParticleCount()).toBe(32);

    for (let i = 0; i < 30; i += 1) {
      FXWorld.update(1 / 60);
    }
    expect(emitters.totalParticleCount()).toBe(32);
  });
});

describe("SceneEmitters: particle overflow for the viewport stats", () => {
  it("is unknown before any emitter is built", () => {
    expect(createPreview().totalParticleOverflowCount()).toBeUndefined();
  });

  it("counts births lost to an emitter whose Expected Capacity is too small", () => {
    const store = new Store(createTestState(), new SignalBus());
    updateNodeParam(store, "behaviorGraph", SPAWN_SINK_ID, SPAWN_EXPECTED_CAPACITY_PARAM, 16);
    const emitters = createPreview();
    emitters.sync(store.getSource().scene);
    const emitterId = store.getSource().scene.emitters[0].id;

    emitters.spawn(emitterId, { kind: "burst", count: 16 });
    FXWorld.update(0); // births land in a tick; a paused one seeds without simulating
    expect(emitters.totalParticleOverflowCount()).toEqual({ count: 0, partial: false });

    emitters.spawn(emitterId, { kind: "burst", count: 4 }); // the ring is full: four live particles are replaced
    FXWorld.update(0); // births land in a tick; a paused one seeds without simulating
    expect(emitters.totalParticleCount()).toBe(16);
    expect(emitters.totalParticleOverflowCount()).toEqual({ count: 4, partial: false });
  });

  it("counts each run from its stop or rewind, not from the build", () => {
    const store = new Store(createTestState(), new SignalBus());
    updateNodeParam(store, "behaviorGraph", SPAWN_SINK_ID, SPAWN_EXPECTED_CAPACITY_PARAM, 16);
    const emitters = createPreview();
    emitters.sync(store.getSource().scene);
    const emitterId = store.getSource().scene.emitters[0].id;
    emitters.spawn(emitterId, { kind: "burst", count: 20 });
    FXWorld.update(0); // births land in a tick; a paused one seeds without simulating
    expect(emitters.totalParticleOverflowCount()?.count).toBe(4);

    emitters.resetAll();
    expect(emitters.totalParticleOverflowCount()?.count).toBe(0);
    emitters.spawn(emitterId, { kind: "burst", count: 18 });
    FXWorld.update(0); // births land in a tick; a paused one seeds without simulating
    expect(emitters.totalParticleOverflowCount()?.count).toBe(2);
  });
});
