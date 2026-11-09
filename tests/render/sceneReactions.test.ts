import { afterEach, describe, expect, it } from "vitest";
import { FXWorld } from "sparcoon";
import {
  addReaction,
  removeEmitter,
  removeReaction,
  updateNodeParam,
  updateReaction,
} from "../../src/model/commands";
import { createDefaultEmitter, type EmitterDoc } from "../../src/model/editorState";
import { SignalBus } from "../../src/model/signals";
import { Store } from "../../src/model/store";
import type { SceneEmitters } from "../../src/render/sceneEmitters";
import {
  RENDER_SINK_ID,
  SPAWN_EXPECTED_CAPACITY_PARAM,
  SPAWN_SINK_ID,
} from "../../src/domain/nodePalette";
import { RENDER_MODE_PARAM_KEY } from "../../src/domain/sinkMeta";
import { createPreview, destroyPreviews } from "../helpers/previewScene";
import { createTestState } from "../helpers/testDocument";

/** A shell (lifetime 2 s, the starter's) and idle sparks, both in a live preview. */
function preview(): { store: Store; emitters: SceneEmitters } {
  const state = createTestState();
  const sparks: EmitterDoc = { ...createDefaultEmitter("sparks", "Sparks"), events: [] };
  state.source = {
    ...state.source,
    scene: {
      ...state.source.scene,
      emitters: [createDefaultEmitter("shell", "Shell"), sparks],
      activeEmitterId: "shell",
    },
  };
  return { store: new Store(state, new SignalBus()), emitters: createPreview() };
}

/**
 * Steps the world to `seconds` in exact 1/8 s ticks: well past the shells' 2 s lifetime and the
 * frame their reactions spawn on, while the sparks (2 s too) all live on. With the shells dead, the
 * scene's particle count is the sparks'.
 */
function runTo(seconds: number): void {
  for (let elapsed = 0; elapsed < seconds; elapsed += 0.125) {
    FXWorld.update(0.125);
  }
}

afterEach(destroyPreviews);

describe("SceneEmitters: death reactions in the live preview", () => {
  it("spawns on the reacting emitter where the source's particles die", () => {
    const { store, emitters } = preview();
    addReaction(store, "sparks", "shell", { kind: "burst", count: 2 });
    emitters.sync(store.getSource().scene);
    emitters.spawn("shell", { kind: "burst", count: 5 });
    runTo(2.5);
    expect(emitters.totalParticleCount()).toBe(10);
  });

  it("plays a play reaction out once per death, for its duration only", () => {
    const { store, emitters } = preview();
    addReaction(store, "sparks", "shell", { kind: "play", rate: 20, duration: 0.5 });
    emitters.sync(store.getSource().scene);
    emitters.spawn("shell", { kind: "burst", count: 2 });
    runTo(3);
    expect(emitters.totalParticleCount()).toBe(2 * 20 * 0.5);
    runTo(0.5);
    expect(emitters.totalParticleCount()).toBe(2 * 20 * 0.5);
  });

  it("follows a reaction's new numbers after a view edit, without a rebuild", () => {
    const { store, emitters } = preview();
    const id = addReaction(store, "sparks", "shell", { kind: "burst", count: 1 }) ?? "";
    emitters.sync(store.getSource().scene);
    updateReaction(store, "sparks", id, { count: 4 }); // a view edit: what main.ts rewires on
    emitters.wireReactions(store.getSource().scene);
    emitters.spawn("shell", { kind: "burst", count: 2 });
    runTo(2.5);
    expect(emitters.totalParticleCount()).toBe(8);
  });

  it("keeps the link across a rebuild of the source", () => {
    const { store, emitters } = preview();
    addReaction(store, "sparks", "shell", { kind: "burst", count: 1 });
    emitters.sync(store.getSource().scene);
    // A capacity edit rebuilds the shell's FXEmitter from scratch; a render-mode one swaps it.
    updateNodeParam(store, "behaviorGraph", SPAWN_SINK_ID, SPAWN_EXPECTED_CAPACITY_PARAM, 128);
    expect(emitters.sync(store.getSource().scene).recompiled).toBe(true);
    updateNodeParam(store, "renderGraph", RENDER_SINK_ID, RENDER_MODE_PARAM_KEY, "opaque");
    emitters.sync(store.getSource().scene);
    emitters.spawn("shell", { kind: "burst", count: 3 });
    runTo(2.5);
    expect(emitters.totalParticleCount()).toBe(3);
  });

  it("stops spawning once the reaction is removed", () => {
    const { store, emitters } = preview();
    const id = addReaction(store, "sparks", "shell", { kind: "burst", count: 2 }) ?? "";
    emitters.sync(store.getSource().scene);
    removeReaction(store, "sparks", id);
    emitters.sync(store.getSource().scene);
    emitters.spawn("shell", { kind: "burst", count: 5 });
    runTo(2.5);
    expect(emitters.totalParticleCount()).toBe(0);
  });

  it("drops the link with a removed source, keeping the reacting emitter", () => {
    const { store, emitters } = preview();
    addReaction(store, "sparks", "shell", { kind: "burst", count: 2 });
    emitters.sync(store.getSource().scene);
    emitters.spawn("shell", { kind: "burst", count: 5 });
    removeEmitter(store, "shell");
    emitters.sync(store.getSource().scene);
    runTo(2.5);
    expect(emitters.totalParticleCount()).toBe(0);
    emitters.spawn("sparks", { kind: "burst", count: 3 });
    runTo(0.125);
    expect(emitters.totalParticleCount()).toBe(3);
  });

  it("spawns nothing more once destroyed, even with source particles left to die", () => {
    const { store, emitters } = preview();
    addReaction(store, "sparks", "shell", { kind: "burst", count: 2 });
    emitters.sync(store.getSource().scene);
    emitters.spawn("shell", { kind: "burst", count: 5 });
    runTo(0.125);
    expect(emitters.totalParticleCount()).toBe(5);
    emitters.destroy();
    expect(() => runTo(2.5)).not.toThrow();
    expect(emitters.totalParticleCount()).toBe(0);
  });
});
