import { describe, expect, it } from "vitest";

import { createEditApi } from "../../src/agent/editApi";
import { liveSession } from "../../src/agent/transaction.Internal";
import { sceneView } from "../../src/agent/views";
import { createDefaultEmitter, createInitialState } from "../../src/model/editorState";
import { SignalBus } from "../../src/model/signals";
import { Store } from "../../src/model/store";

/** Two starter emitters, `emitter_a` and `emitter_b`, through the live agent API. */
function setup(): { store: Store; api: ReturnType<typeof createEditApi> } {
  const state = createInitialState();
  const emitters = [createDefaultEmitter("emitter_a", "A"), createDefaultEmitter("emitter_b", "B")];
  state.source = {
    ...state.source,
    scene: { ...state.source.scene, emitters, activeEmitterId: "emitter_a" },
  };
  const store = new Store(state, new SignalBus());
  return { store, api: createEditApi(liveSession(store)) };
}

describe("agent timeline: birth reactions", () => {
  it("adds a birth reaction, switches its event and refuses an unknown one", () => {
    const { store, api } = setup();
    const id = api.timeline.addBurstOnBirth("emitter_b", "emitter_a", 6);
    api.timeline.addPlayOnBirth("emitter_b", "emitter_a", 10, 0.5);
    const reactions = (): readonly { on: string }[] =>
      sceneView(store.getSource()).emitters[1]?.reactions ?? [];
    expect(reactions().map((reaction) => reaction.on)).toEqual(["birth", "birth"]);
    api.timeline.updateReaction("emitter_b", id, { on: "death" });
    expect(reactions()[0]?.on).toBe("death");
    expect(() => api.timeline.updateReaction("emitter_b", id, { on: "spawn" as "birth" })).toThrow(
      /on must be one of/,
    );
    expect(() => api.timeline.addBurstOnBirth("emitter_a", "emitter_b", 1)).toThrow(/cycle/);
  });
});

describe("agent timeline: death reactions", () => {
  it("adds, edits and removes a reaction, and shows it in the scene view", () => {
    const { store, api } = setup();
    const id = api.timeline.addBurstOnDeath("emitter_b", "emitter_a", 6);
    api.timeline.updateReaction("emitter_b", id, { count: 9 });
    expect(sceneView(store.getSource()).emitters[1]?.reactions).toEqual([
      { id, source: "emitter_a", on: "death", kind: "burst", count: 9 },
    ]);
    api.timeline.removeReaction("emitter_b", id);
    expect(sceneView(store.getSource()).emitters[1]?.reactions).toEqual([]);
  });

  it("refuses a cycle, an emitter reacting to itself, and a play without end", () => {
    const { api } = setup();
    api.timeline.addBurstOnDeath("emitter_b", "emitter_a", 1);
    expect(() => api.timeline.addBurstOnDeath("emitter_a", "emitter_b", 1)).toThrow(/cycle/);
    expect(() => api.timeline.addBurstOnDeath("emitter_a", "emitter_a", 1)).toThrow(/cycle/);
    expect(() => api.timeline.addPlayOnDeath("emitter_a", "nope", 5, 1)).toThrow(/nope/);
    expect(() => api.timeline.addPlayOnDeath("emitter_b", "emitter_a", 5, 0)).toThrow(
      /duration above 0/,
    );
  });

  it("refuses a field the reaction's kind does not carry, and an unknown reaction", () => {
    const { api } = setup();
    const id = api.timeline.addPlayOnDeath("emitter_b", "emitter_a", 5, 0.5);
    expect(() => api.timeline.updateReaction("emitter_b", id, { count: 3 })).toThrow(
      /no field "count"/,
    );
    expect(() => api.timeline.updateReaction("emitter_b", id, { duration: 0 })).toThrow(
      /duration above 0/,
    );
    expect(() => api.timeline.removeReaction("emitter_b", "ghost")).toThrow(/not_found|ghost/);
  });
});
