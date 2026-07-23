import { describe, expect, it } from "vitest";
import { PerspectiveCamera, Scene, Texture, type WebGLRenderer } from "three";
import { FXWorld } from "sparcoon";
import { Store } from "../../src/model/store";
import { SignalBus } from "../../src/model/signals";
import { createTestState } from "../helpers/testDocument";
import { SPAWN_SINK_ID, SPAWN_TRY_GPU_SIMULATION_PARAM } from "../../src/domain/nodePalette";
import { updateNodeParam } from "../../src/model/commands";
import { SceneEmitters } from "../../src/render/sceneEmitters";

// Nothing previously exercised SceneEmitters.burst through the real live-preview construction path
// (EmitterView -> FXEmitter.fromArtifacts via "sparcoon/editor") end to end - only the lower-level
// compileToArtifacts/emitModule tests build a bare FXEmitter directly. This closes that gap.
describe("SceneEmitters: emitter burst through the live-preview path", () => {
  it("burst on the default emitter spawns particles and they survive FXWorld ticks", () => {
    const store = new Store(createTestState(), new SignalBus());
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    // The default emitter has "Try GPU simulation" on by default, but this stub claims WebGL1 -
    // installEmitter's isWebGL2 gate keeps the compiled program unused, falling back to the JS
    // driver, so a shape stub is enough, matching this headless suite's no-real-WebGL policy
    // (tests/setup.ts).
    const renderer = { capabilities: { isWebGL2: false } } as unknown as WebGLRenderer;
    const emitters = new SceneEmitters(
      scene,
      () => new Texture(),
      camera,
      renderer,
      "baseline",
      () => 0,
    );
    const source = store.getSource();
    emitters.sync(source.scene);
    const emitterId = source.scene.emitters[0].id;

    emitters.burst(emitterId, 32);
    expect(emitters.totalParticleCount()).toBe(32);

    for (let i = 0; i < 30; i += 1) {
      FXWorld.update(1 / 60);
    }
    expect(emitters.totalParticleCount()).toBe(32);
  });

  it('burst still works with "Try GPU simulation" on, degrading to the JS driver in this headless suite', () => {
    const store = new Store(createTestState(), new SignalBus());
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    // Claims WebGL2 so EmitterView.installEmitter actually wires the compiled standard-family
    // program through as gpuKernel - but it is not a real WebGL2 context, so FXEmitter.
    // fromArtifacts's own driver construction still falls back to the JS driver (FXEmitter.ts's
    // try/catch around `new FXGPUEmitterDriver`), exactly as it would on a real device whose
    // WebGL2 implementation rejects the compiled program at runtime.
    const renderer = { capabilities: { isWebGL2: true } } as unknown as WebGLRenderer;
    const emitters = new SceneEmitters(
      scene,
      () => new Texture(),
      camera,
      renderer,
      "baseline",
      () => 0,
    );
    const emitterId = store.getSource().scene.emitters[0].id;
    updateNodeParam(store, "behaviorGraph", SPAWN_SINK_ID, SPAWN_TRY_GPU_SIMULATION_PARAM, true);

    expect(() => emitters.sync(store.getSource().scene)).not.toThrow();
    emitters.burst(emitterId, 32);
    expect(emitters.totalParticleCount()).toBe(32);

    for (let i = 0; i < 30; i += 1) {
      FXWorld.update(1 / 60);
    }
    expect(emitters.totalParticleCount()).toBe(32);
  });
});
