import { describe, expect, it } from "vitest";
import { PerspectiveCamera, Scene, Texture, type WebGLRenderer } from "three";
import { createInitialState } from "../../src/model/editorState";
import { Store } from "../../src/model/store";
import { SignalBus } from "../../src/model/signals";
import {
  RENDER_MODE_PARAM_KEY,
  RENDER_SINK_ID,
  SPAWN_SINK_ID,
  SPAWN_TRY_GPU_SIMULATION_PARAM,
} from "../../src/domain/nodePalette";
import { updateNodeParam } from "../../src/model/commands";
import { SceneEmitters } from "../../src/render/sceneEmitters";

// Regression for "a render-only edit restarts playback": a structural change confined to the
// render half (e.g. the surface sink's Render Mode) must hot-swap the live FXEmitter in place
// instead of a full rebuild - live particles must survive and `recompiled` must stay false.
describe("SceneEmitters: render-only edits do not reset playback", () => {
  function buildScene(): { store: Store; emitters: SceneEmitters } {
    const store = new Store(createInitialState(), new SignalBus());
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    // JS driver only (matches sceneEmitterBurst.test.ts's no-real-WebGL headless policy) - the
    // render-only swap path is backend-agnostic, so this is enough to exercise it.
    const renderer = { capabilities: { isWebGL2: false } } as unknown as WebGLRenderer;
    const emitters = new SceneEmitters(
      scene,
      () => new Texture(),
      camera,
      renderer,
      "baseline",
      () => 0,
    );
    return { store, emitters };
  }

  it("a render-mode change hot-swaps in place: particles survive and recompiled is not reported", () => {
    const { store, emitters } = buildScene();
    const source = store.getSource();
    emitters.sync(source.scene);
    const emitterId = source.scene.emitters[0].id;

    emitters.burst(emitterId, 32);
    expect(emitters.totalParticleCount()).toBe(32);

    updateNodeParam(store, "renderGraph", RENDER_SINK_ID, RENDER_MODE_PARAM_KEY, "opaque");
    const result = emitters.sync(store.getSource().scene);

    expect(result.recompiled).not.toBe(true);
    expect(emitters.totalParticleCount()).toBe(32);
  });

  it("a behavior-graph edit (contrast case) still fully rebuilds and resets particles", () => {
    const { store, emitters } = buildScene();
    const source = store.getSource();
    emitters.sync(source.scene);
    const emitterId = source.scene.emitters[0].id;

    emitters.burst(emitterId, 32);
    expect(emitters.totalParticleCount()).toBe(32);

    // The default emitter already has "Try GPU simulation" on (sinkMeta.ts's default), so this
    // must flip it OFF to actually change the built value and force a rebuild.
    updateNodeParam(store, "behaviorGraph", SPAWN_SINK_ID, SPAWN_TRY_GPU_SIMULATION_PARAM, false);
    const result = emitters.sync(store.getSource().scene);

    expect(result.recompiled).toBe(true);
    expect(emitters.totalParticleCount()).toBe(0);
  });
});
