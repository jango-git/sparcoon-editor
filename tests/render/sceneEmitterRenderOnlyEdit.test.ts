import { afterEach, describe, expect, it } from "vitest";
import { FXWorld } from "sparcoon";
import { Store } from "../../src/model/store";
import { SignalBus } from "../../src/model/signals";
import {
  RENDER_MODE_PARAM_KEY,
  RENDER_SINK_ID,
  SPAWN_SINK_ID,
  SPAWN_TRY_GPU_SIMULATION_PARAM,
} from "../../src/domain/nodePalette";
import { updateNodeParam } from "../../src/model/commands";
import type { SceneEmitters } from "../../src/render/sceneEmitters";
import { createPreview, destroyPreviews } from "../helpers/previewScene";
import { createTestState } from "../helpers/testDocument";

afterEach(destroyPreviews);

// A structural change confined to the render half (e.g. the surface sink's Render Mode) hot-swaps
// the live FXEmitter in place instead of a full rebuild: live particles survive and `recompiled`
// stays false, so playback is not restarted.
describe("SceneEmitters: render-only edits do not reset playback", () => {
  // JS driver only - the render-only swap path is backend-agnostic, so this is enough to exercise it.
  function buildScene(): { store: Store; emitters: SceneEmitters } {
    return { store: new Store(createTestState(), new SignalBus()), emitters: createPreview() };
  }

  it("a render-mode change hot-swaps in place: particles survive and recompiled is not reported", () => {
    const { store, emitters } = buildScene();
    const source = store.getSource();
    emitters.sync(source.scene);
    const emitterId = source.scene.emitters[0].id;

    emitters.spawn(emitterId, { kind: "burst", count: 32 });
    FXWorld.update(0); // births land in a tick; a paused one seeds without simulating
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

    emitters.spawn(emitterId, { kind: "burst", count: 32 });
    FXWorld.update(0); // births land in a tick; a paused one seeds without simulating
    expect(emitters.totalParticleCount()).toBe(32);

    // The default emitter already has "Try GPU simulation" on (sinkMeta.ts's default), so this
    // must flip it OFF to actually change the built value and force a rebuild.
    updateNodeParam(store, "behaviorGraph", SPAWN_SINK_ID, SPAWN_TRY_GPU_SIMULATION_PARAM, false);
    const result = emitters.sync(store.getSource().scene);

    expect(result.recompiled).toBe(true);
    expect(emitters.totalParticleCount()).toBe(0);
  });
});
