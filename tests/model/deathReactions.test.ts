import { describe, expect, it } from "vitest";
import type * as three from "three";
import * as sparcoon from "sparcoon";
import {
  canReact,
  deathSourceIds,
  effectiveSpawnConfig,
  reactingEmitters,
  reactionSourceCandidates,
  withValidReactions,
} from "../../src/domain/deathReactions";
import {
  addReaction,
  defaultSpawnAction,
  removeEmitter,
  removeReaction,
  updateReaction,
} from "../../src/model/commands";
import {
  createDefaultEmitter,
  type DeathReaction,
  type EmitterDoc,
  type SourceState,
} from "../../src/model/editorState";
import { SignalBus } from "../../src/model/signals";
import { Store } from "../../src/model/store";
import { normalizeSource } from "../../src/persistence/loadState";
import { emitProjectModule } from "../../src/persistence/exportTypeScript";
import { loadModule } from "../helpers/loadModule";
import { createTestState } from "../helpers/testDocument";

/** Emitters `a`, `b`, `c` (starters), `b` reacting to `a`'s deaths with `reactions`. */
function chain(reactions: Readonly<Record<string, readonly DeathReaction[]>> = {}): EmitterDoc[] {
  return ["a", "b", "c"].map((id) => ({
    ...createDefaultEmitter(id, id.toUpperCase()),
    reactions: reactions[id] ?? [],
  }));
}

function burstOn(source: string, id = `r_${source}`, count = 4): DeathReaction {
  return { id, source, kind: "burst", count };
}

function storeWith(emitters: readonly EmitterDoc[], signals = new SignalBus()): Store {
  const state = createTestState();
  state.source = {
    ...state.source,
    scene: { ...state.source.scene, emitters, activeEmitterId: emitters[0]?.id },
  };
  return new Store(state, signals);
}

function emitterOf(store: Store, id: string): EmitterDoc {
  const emitter = store.getSource().scene.emitters.find((candidate) => candidate.id === id);
  if (emitter === undefined) {
    throw new Error(`no emitter ${id}`);
  }
  return emitter;
}

describe("death reaction rules", () => {
  it("refuses an emitter reacting to itself, an unknown one, and any cycle", () => {
    const emitters = chain({ b: [burstOn("a")], c: [burstOn("b")] }); // a -> b -> c
    expect(canReact(emitters, "a", "a")).toBe(false);
    expect(canReact(emitters, "a", "nope")).toBe(false);
    expect(canReact(emitters, "a", "c")).toBe(false); // c -> a would close a -> b -> c -> a
    expect(canReact(emitters, "a", "b")).toBe(false);
    expect(canReact(emitters, "c", "a")).toBe(true); // a second path, no cycle
  });

  it("lets a reaction be re-pointed past the edge it replaces", () => {
    const emitters = chain({ b: [burstOn("a", "r1")] });
    // Re-pointing b's only reaction from a to c: the a -> b edge it drops does not count.
    expect(canReact(emitters, "b", "c", "r1")).toBe(true);
    expect(reactionSourceCandidates(emitters, "a").map((emitter) => emitter.id)).toEqual(["c"]);
  });

  it("names the sources, and who reacts to each", () => {
    const emitters = chain({ b: [burstOn("a")], c: [burstOn("a", "r2")] });
    expect([...deathSourceIds(emitters)]).toEqual(["a"]);
    expect(reactingEmitters(emitters, "a").map((emitter) => emitter.id)).toEqual(["b", "c"]);
  });

  it("runs a death source on the CPU whatever its spawn node asks for", () => {
    const emitters = chain({ b: [burstOn("a")] });
    const scene = { ...createTestState().source.scene, emitters };
    // The starter's spawn node asks for the GPU (its default).
    expect(effectiveSpawnConfig(emitters[0], scene).tryGpuSimulation).toBe(false);
    expect(effectiveSpawnConfig(emitters[1], scene).tryGpuSimulation).toBe(true);
  });

  it("drops a reaction whose source is gone, or that closes a cycle with those before it", () => {
    const emitters = chain({
      a: [burstOn("c", "keep_a")],
      b: [burstOn("ghost", "drop_ghost"), burstOn("a", "keep_b")],
      c: [burstOn("b", "drop_cycle"), burstOn("c", "drop_self")],
    });
    const kept = withValidReactions(emitters);
    expect(kept.map((emitter) => emitter.reactions.map((r) => r.id))).toEqual([
      ["keep_a"],
      ["keep_b"],
      [],
    ]);
    // Untouched emitters are the very same objects.
    expect(kept[0]).toBe(emitters[0]);
  });
});

describe("death reaction commands", () => {
  it("adds a reaction only where it may exist, clamped like an edit", () => {
    const store = storeWith(chain());
    const id = addReaction(store, "b", "a", { kind: "play", rate: 10, duration: 0 });
    expect(id).toBeDefined();
    const [reaction] = emitterOf(store, "b").reactions;
    // A reaction never plays forever: at least one frame.
    expect(reaction).toMatchObject({ source: "a", kind: "play", rate: 10 });
    expect(reaction.kind === "play" && reaction.duration).toBeCloseTo(1 / 30, 6);
    expect(addReaction(store, "a", "b", defaultSpawnAction("burst"))).toBeUndefined(); // a cycle
  });

  it("is a structural edit only when the set of sources changes (where they simulate)", () => {
    const signals = new SignalBus();
    const store = storeWith(chain(), signals);
    const kinds: string[] = [];
    signals.on("sourceStructureChanged", () => kinds.push("structural"));
    signals.on("sourceViewChanged", () => kinds.push("view"));
    const first = addReaction(store, "b", "a", defaultSpawnAction("burst")) ?? ""; // a: a source
    addReaction(store, "c", "a", defaultSpawnAction("burst")); // a already is
    updateReaction(store, "b", first, { count: 3 });
    updateReaction(store, "b", first, { source: "c" }); // c becomes one too
    removeReaction(store, "b", first); // c no longer is
    expect(kinds).toEqual(["structural", "view", "view", "structural", "structural"]);
  });

  it("updates the action, and re-points only to a source that closes no cycle", () => {
    const store = storeWith(chain({ c: [burstOn("b", "c_on_b")] }));
    const id = addReaction(store, "b", "a", defaultSpawnAction("burst")) ?? "";
    updateReaction(store, "b", id, { count: 7.6, rate: 99 });
    expect(emitterOf(store, "b").reactions[0]).toEqual({
      id,
      source: "a",
      kind: "burst",
      count: 8,
    });
    updateReaction(store, "b", id, { source: "c" }); // c reacts to b: refused
    expect(emitterOf(store, "b").reactions[0]?.source).toBe("a");
    removeReaction(store, "b", id);
    expect(emitterOf(store, "b").reactions).toEqual([]);
  });

  it("drops the reactions to an emitter along with it", () => {
    const store = storeWith(chain({ b: [burstOn("a")], c: [burstOn("b")] }));
    removeEmitter(store, "a");
    expect(emitterOf(store, "b").reactions).toEqual([]);
    expect(emitterOf(store, "c").reactions).toHaveLength(1);
  });
});

describe("death reactions in a saved document", () => {
  function saved(emitters: readonly unknown[]): unknown {
    const source = createTestState().source;
    return { ...source, scene: { ...source.scene, emitters } };
  }

  it("reads a document saved before reactions existed with none", () => {
    const old: Record<string, unknown> = { ...createDefaultEmitter("a", "A") };
    delete old["reactions"];
    const source = normalizeSource(saved([old]));
    expect(source?.scene.emitters[0]?.reactions).toEqual([]);
  });

  it("keeps well-formed reactions and drops corrupt, endless or over-distance ones", () => {
    const [a, b] = chain();
    const source = normalizeSource(
      saved([
        a,
        {
          ...b,
          reactions: [
            { id: "ok", source: "a", kind: "play", rate: 5, duration: 0.5 },
            { id: "endless", source: "a", kind: "play", rate: 5, duration: 0 },
            { id: "distance", source: "a", kind: "play", rate: 5, duration: 1, over: "distance" },
            { id: "no_source", kind: "burst", count: 3 },
            { id: "bad_kind", source: "a", kind: "spray", count: 3 },
          ],
        },
      ]),
    );
    expect(source?.scene.emitters[1]?.reactions.map((reaction) => reaction.id)).toEqual(["ok"]);
  });
});

describe("death reactions in the export", () => {
  /** Shell bursts 4 at 0 and lives 2 s; Sparks has no events and bursts 3 per shell death. */
  function shellAndSparks(): SourceState {
    const source = createTestState().source;
    const shell: EmitterDoc = {
      ...createDefaultEmitter("shell", "Shell"),
      events: [{ id: "e", kind: "burst", time: 0, count: 4 }],
    };
    const sparks: EmitterDoc = {
      ...createDefaultEmitter("sparks", "Sparks"),
      events: [],
      reactions: [{ id: "r", source: "shell", kind: "burst", count: 3 }],
    };
    return {
      ...source,
      scene: {
        ...source.scene,
        emitters: [shell, sparks],
      },
    };
  }

  it("ships each reaction with its source's index, and the source without a GPU kernel", () => {
    const text = emitProjectModule(shellAndSparks());
    const [shellBlock, sparksBlock] = text.split(/name: "(?:Shell|Sparks)"/).slice(1);
    expect(shellBlock).not.toMatch(/gpuBehavior:/);
    expect(shellBlock).not.toMatch(/reactions:/);
    expect(sparksBlock).toMatch(/gpuBehavior:/);
    expect(sparksBlock).toContain('reactions: [{"kind":"burst","count":3,"source":0}],');
  });

  type ExportedEffect = three.Group & {
    play(): void;
    dispose(): void;
    getEmitter(name: string): { particleCount: number } | undefined;
  };

  /** Plays the exported `source`, hands it to `run`, and disposes it. */
  function playExport(source: SourceState, run: (effect: ExportedEffect) => void): void {
    const Effect = loadModule(emitProjectModule(source))["Effect"] as new (
      assets: Record<string, never>,
    ) => ExportedEffect;
    const effect = new Effect({});
    try {
      effect.play();
      run(effect);
    } finally {
      effect.dispose();
    }
  }

  /** `shellAndSparks` with Sparks playing instead: 20 per second for half a second per death. */
  function shellAndPlayingSparks(): SourceState {
    const source = shellAndSparks();
    const [shell, sparks] = source.scene.emitters;
    const play: DeathReaction = { id: "r", source: "shell", kind: "play", rate: 20, duration: 0.5 };
    return {
      ...source,
      scene: { ...source.scene, emitters: [shell, { ...sparks, reactions: [play] }] },
    };
  }

  it("bursts the sparks the frame after the shells die, never in the same one", () => {
    // 3/8 s steps are exact in binary and straddle the 2 s lifetime instead of landing on it.
    playExport(shellAndSparks(), (effect) => {
      const count = (name: string): number | undefined => effect.getEmitter(name)?.particleCount;
      sparcoon.FXWorld.update(0.375); // the t=0 burst
      expect(count("Shell")).toBe(4);
      for (let ticks = 1; count("Shell") !== 0 && ticks < 10; ticks += 1) {
        sparcoon.FXWorld.update(0.375);
      }
      expect(count("Shell")).toBe(0);
      expect(count("Sparks")).toBe(0);
      sparcoon.FXWorld.update(0.375);
      expect(count("Sparks")).toBe(12);
    });
  });

  it("ships a play reaction with its rate and duration, and every death plays it out once", () => {
    const source = shellAndPlayingSparks();
    expect(emitProjectModule(source)).toContain(
      'reactions: [{"kind":"play","rate":20,"duration":0.5,"source":0}],',
    );
    playExport(source, (effect) => {
      const sparks = (): number | undefined => effect.getEmitter("Sparks")?.particleCount;
      for (let i = 0; i < 24; i += 1) {
        sparcoon.FXWorld.update(0.125); // to 3 s: the shells die at 2 s, each play lasts 0.5 s
      }
      expect(sparks()).toBe(4 * 20 * 0.5);
      for (let i = 0; i < 4; i += 1) {
        sparcoon.FXWorld.update(0.125); // the plays have ended; the sparks (2 s) are still alive
      }
      expect(sparks()).toBe(4 * 20 * 0.5);
    });
  });
});
