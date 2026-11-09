import { describe, expect, it } from "vitest";
import * as three from "three";
import * as sparcoon from "sparcoon";
import { createDefaultVfxMesh, type SourceState } from "../../src/model/editorState";
import { createEmptyGraph, type EditorGraph } from "../../src/domain/graphModel";
import { ensureSinks } from "../../src/domain/sinks";
import {
  GraphKind,
  RENDER_SINK_ID,
  SPAWN_SINK_ID,
  SPAWN_TRY_GPU_SIMULATION_PARAM,
} from "../../src/domain/nodePalette";
import { emitProjectModule } from "../../src/persistence/exportTypeScript";
import { renderArtifactDeclarations } from "../../src/engine/emit/artifactLiterals";
import { loadModule } from "../helpers/loadModule";
import { createTestState } from "../helpers/testDocument";

/** The live particle count across every FXEmitter the effect built.
 *  `"particleCount" in child`, not `instanceof sparcoon.FXEmitter`: `FXEmitter` is a type-only
 *  export from the main entry (not constructible/class-identity-checkable there), and sparcoon
 *  resolves its own `three` copy (a separate node_modules install) besides - the same reason the
 *  mesh check below duck-types on `.type` instead of `instanceof three.Mesh`. */
function totalParticles(effect: three.Group): number {
  let total = 0;
  for (const child of effect.children) {
    if ("particleCount" in child && typeof child.particleCount === "number") {
      total += child.particleCount;
    }
  }
  return total;
}

/** A source whose one emitter samples an external texture into albedo (drives the asset path). */
function textureEmitterSource(): SourceState {
  const base = createTestState().source;
  const emitter = base.scene.emitters[0];
  const renderGraph = ensureSinks(
    {
      ...createEmptyGraph(),
      nodes: {
        textureNode: {
          id: "textureNode",
          type: "texture",
          parameters: { name: "sprite" },
          position: { x: 120, y: 120 },
        },
      },
      outputBindings: [{ slot: "albedo", from: { nodeId: "textureNode", socketKey: "color" } }],
    },
    GraphKind.Render,
  );
  return {
    ...base,
    assets: [{ name: "sprite", label: "sprite.png", dataUrl: "data:,", width: 1, height: 1 }],
    scene: { ...base.scene, emitters: [{ ...emitter, renderGraph }] },
  };
}

/** A source whose one emitter has a live position channel. */
function fakePositionEmitterSource(): SourceState {
  const base = createTestState().source;
  const emitter = base.scene.emitters[0];
  return {
    ...base,
    scene: {
      ...base.scene,
      emitters: [
        {
          ...emitter,
          transformTracks: [
            { channel: "position", keys: [{ id: "k1", time: 0, value: [9, 9, 9] }] },
          ],
          liveChannels: ["position"],
        },
      ],
    },
  };
}

/** A source whose one emitter has a live Timeline Value track driving a `tint` uniform. */
function fakeParamEmitterSource(): SourceState {
  const base = createTestState().source;
  const emitter = base.scene.emitters[0];
  const renderGraph = ensureSinks(
    {
      ...createEmptyGraph(),
      nodes: {
        tintNode: {
          id: "tintNode",
          type: "timeline-value",
          parameters: { name: "tint", type: "vec4", value: [1, 1, 1, 1] },
          position: { x: 120, y: 120 },
        },
      },
      outputBindings: [{ slot: "albedo", from: { nodeId: "tintNode", socketKey: "out" } }],
    },
    GraphKind.Render,
  );
  return {
    ...base,
    scene: {
      ...base.scene,
      emitters: [
        {
          ...emitter,
          renderGraph,
          tracks: [{ name: "tint", keys: [{ id: "k1", time: 0, value: [0.25, 0.5, 0.75, 1] }] }],
          liveParams: ["tint"],
        },
      ],
    },
  };
}

/** `graph` with its surface sink's shadow flags set as given (an undefined one left unset): they
 *  live on the render graph's surface sink, like geometry/sortInterval, not on the entity. */
function withSinkShadow(graph: EditorGraph, cast?: boolean, receive?: boolean): EditorGraph {
  const sink = graph.nodes[RENDER_SINK_ID];
  return {
    ...graph,
    nodes: {
      ...graph.nodes,
      [RENDER_SINK_ID]: {
        ...sink,
        parameters: {
          ...sink.parameters,
          ...(cast !== undefined ? { castShadow: cast } : {}),
          ...(receive !== undefined ? { receiveShadow: receive } : {}),
        },
      },
    },
  };
}

function emitterWithShadows(cast?: boolean, receive?: boolean): SourceState {
  const base = createTestState().source;
  const emitter = base.scene.emitters[0];
  return {
    ...base,
    scene: {
      ...base.scene,
      emitters: [{ ...emitter, renderGraph: withSinkShadow(emitter.renderGraph, cast, receive) }],
    },
  };
}

/** The starter with "Try GPU simulation" set on its spawn sink - the same read-a-sink-parameter
 *  pattern as the shadow flags. */
function emitterWithGpuFlag(on: boolean): SourceState {
  const base = createTestState().source;
  const emitter = base.scene.emitters[0];
  const graph = emitter.behaviorGraph;
  const sink = graph.nodes[SPAWN_SINK_ID];
  const behaviorGraph: EditorGraph = {
    ...graph,
    nodes: {
      ...graph.nodes,
      [SPAWN_SINK_ID]: {
        ...sink,
        parameters: { ...sink.parameters, [SPAWN_TRY_GPU_SIMULATION_PARAM]: on },
      },
    },
  };
  return { ...base, scene: { ...base.scene, emitters: [{ ...emitter, behaviorGraph }] } };
}

describe("renderArtifactDeclarations", () => {
  it("names an earlier tier's word-for-word identical artifact instead of repeating it", () => {
    expect(
      renderArtifactDeclarations([
        { name: "aBaseline", body: "{ a: 1 }" },
        { name: "aStandard", body: "{ a: 1 }" },
      ]),
    ).toEqual([
      "const aBaseline: FXRenderArtifact = { a: 1 };",
      "const aStandard: FXRenderArtifact = aBaseline;",
    ]);
  });

  it("writes out each tier whose artifact differs", () => {
    expect(
      renderArtifactDeclarations(
        [
          { name: "renderBaseline", body: "{ a: 1 }" },
          { name: "renderStandard", body: "{ a: 2 }" },
        ],
        "export const",
      ),
    ).toEqual([
      "export const renderBaseline: FXRenderArtifact = { a: 1 };",
      "export const renderStandard: FXRenderArtifact = { a: 2 };",
    ]);
  });
});

describe("emitProjectModule - structure", () => {
  it("emits a self-contained class with per-entity artifacts and a scene spec", () => {
    const text = emitProjectModule(createTestState().source);

    // Machine-emitted kernel bodies + untyped engine helpers -> the file opts out of strict checking
    // while keeping its exported class/interfaces typed for the consumer.
    expect(text.startsWith("// @ts-nocheck\n")).toBe(true);
    expect(text).toContain('from "sparcoon"');
    expect(text).toContain('from "three"');
    expect(text).toContain("  FXEffect,");
    expect(text).toContain("const render0Baseline: FXRenderArtifact = {");
    // The default graph uses nothing only one tier has: Standard names Baseline's artifact.
    expect(text).toContain("const render0Standard: FXRenderArtifact = render0Baseline;");
    expect(text).toContain("const behavior0: FXBehaviorArtifact = {");
    expect(text).toContain("const SPEC: FXEffectSpec = {");
    expect(text).toContain("export class Effect extends FXEffect");
    // No Texture nodes in the default project -> no assets required.
    expect(text).toContain("export type EffectAssets = Record<string, never>;");
  });

  it("declares a typed asset per external texture slot", () => {
    const text = emitProjectModule(textureEmitterSource());
    expect(text).toContain("export interface EffectAssets {");
    expect(text).toContain("sprite: Texture;");
    expect(text).toContain('externalSlots: ["sprite"]');
  });

  it("renames a project whose class name would collide with a module identifier", () => {
    const rename = (source: SourceState, name: string): SourceState => ({ ...source, name });
    const base = createTestState().source;
    expect(emitProjectModule(rename(base, "SPEC"))).toContain("export class SPECExport extends");
    expect(emitProjectModule(rename(base, "FX Effect Options"))).toContain(
      "export class FXEffectOptionsExport extends",
    );
  });
});

describe("emitProjectModule - executes", () => {
  it("builds an emitter that spawns from its timeline burst event", () => {
    const module = loadModule(emitProjectModule(createTestState().source));
    const Effect = module["Effect"] as new (assets: Record<string, never>) => three.Group & {
      play(): void;
      dispose(): void;
    };

    const effect = new Effect({});
    try {
      expect(totalParticles(effect)).toBe(0); // idle until played
      effect.play();
      sparcoon.FXWorld.update(0.1); // crosses the t=0 burst of 32
      expect(totalParticles(effect)).toBe(32);
      sparcoon.FXWorld.update(0.1);
      expect(totalParticles(effect)).toBe(32); // lifetime 2s -> still alive
    } finally {
      effect.dispose();
    }
  });

  it("carries the timeline's loop setting: a once-through effect finishes and holds", () => {
    const source = createTestState().source;
    const once = { ...source, timeline: { ...source.timeline, loop: false } };
    const text = emitProjectModule(once);
    expect(text).toMatch(/^\s*loop: false,$/m);
    const Effect = loadModule(text)["Effect"] as new (
      assets: Record<string, never>,
    ) => three.Group & {
      play(): void;
      dispose(): void;
    };
    const effect = new Effect({});
    let finished = 0;
    effect.addEventListener("finished" as never, () => {
      finished += 1;
    });
    try {
      effect.play();
      for (let step = 0; step < 60; step += 1) {
        sparcoon.FXWorld.update(0.1); // well past the end
      }
      expect(finished).toBe(1);
    } finally {
      effect.dispose();
    }
  });

  it("stop() clears live particles", () => {
    const module = loadModule(emitProjectModule(createTestState().source));
    const Effect = module["Effect"] as new (assets: Record<string, never>) => three.Group & {
      play(): void;
      stop(): void;
      dispose(): void;
    };
    const effect = new Effect({});
    try {
      effect.play();
      sparcoon.FXWorld.update(0.1);
      expect(totalParticles(effect)).toBe(32);
      effect.stop();
      expect(totalParticles(effect)).toBe(0);
    } finally {
      effect.dispose();
    }
  });

  it("emits distinct, namespaced artifacts for multiple emitters and drives them all", () => {
    const base = createTestState().source;
    const first = base.scene.emitters[0];
    const second = { ...first, id: "emitter_2", name: "Second" };
    const source: SourceState = {
      ...base,
      scene: { ...base.scene, emitters: [first, second] },
    };
    const text = emitProjectModule(source);
    expect(text).toContain("const render0Baseline: FXRenderArtifact = {");
    expect(text).toContain("const render1Standard: FXRenderArtifact = render1Baseline;");
    expect(text).toContain("const behavior1: FXBehaviorArtifact = {");

    const module = loadModule(text);
    const Effect = module["Effect"] as new (assets: Record<string, never>) => three.Group & {
      play(): void;
      dispose(): void;
    };
    const effect = new Effect({});
    try {
      effect.play();
      sparcoon.FXWorld.update(0.1); // both emitters burst 32 at t=0
      expect(totalParticles(effect)).toBe(64);
    } finally {
      effect.dispose();
    }
  });

  it("builds a VFX mesh as a Mesh child", () => {
    const base = createTestState().source;
    const mesh = createDefaultVfxMesh("mesh_1", "Mesh");
    const source: SourceState = {
      ...base,
      scene: { ...base.scene, meshes: [mesh] },
    };
    const module = loadModule(emitProjectModule(source));
    const Effect = module["Effect"] as new (assets: Record<string, never>) => three.Group & {
      dispose(): void;
    };
    const effect = new Effect({});
    try {
      // `instanceof three.Mesh` would compare against this test's own `three` import, which is a
      // different module instance than the one `sparcoon`'s compiled dist resolves internally in
      // this dev checkout (nested node_modules) - three tags every Object3D with a `.type` string
      // precisely so consumers can identify it without relying on class identity.
      const meshes = effect.children.filter((child) => child.type === "Mesh");
      expect(meshes.length).toBe(1);
      sparcoon.FXWorld.update(0.05); // pushes the mesh material clock without throwing
    } finally {
      effect.dispose();
    }
  });

  it("skips a degenerate zero-count burst instead of throwing out of update", () => {
    const base = createTestState().source;
    const emitter = base.scene.emitters[0];
    const source: SourceState = {
      ...base,
      scene: {
        ...base.scene,
        emitters: [{ ...emitter, events: [{ id: "e0", kind: "burst", time: 0, count: 0 }] }],
      },
    };
    const module = loadModule(emitProjectModule(source));
    const Effect = module["Effect"] as new (assets: Record<string, never>) => three.Group & {
      play(): void;
      dispose(): void;
    };
    const effect = new Effect({});
    try {
      effect.play();
      expect(() => sparcoon.FXWorld.update(0.1)).not.toThrow(); // FXEmitter.burst(0) would assert-throw
      expect(totalParticles(effect)).toBe(0);
    } finally {
      effect.dispose();
    }
  });

  it("is inert after dispose (update/play/stop do not throw)", () => {
    const module = loadModule(emitProjectModule(createTestState().source));
    const Effect = module["Effect"] as new (assets: Record<string, never>) => three.Group & {
      play(): void;
      stop(): void;
      dispose(): void;
    };
    const effect = new Effect({});
    effect.play();
    sparcoon.FXWorld.update(0.1);
    effect.dispose();
    effect.dispose(); // idempotent
    expect(() => {
      sparcoon.FXWorld.update(0.1);
      effect.play();
      effect.stop();
    }).not.toThrow();
  });

  it.each([
    {
      variant: "an external texture supplied to the constructor",
      source: textureEmitterSource,
      assets: (): Record<string, three.Texture> => ({ sprite: new three.Texture() }),
      marker: 'externalSlots: ["sprite"]',
    },
    {
      variant: "a cast-shadow emitter",
      source: () => emitterWithShadows(true, true),
      assets: (): Record<string, three.Texture> => ({}),
      marker: "castShadow: true,",
    },
    {
      // No renderer is supplied, so the mandatory JS fallback is what actually drives it.
      variant: "a GPU-simulated emitter",
      source: () => emitterWithGpuFlag(true),
      assets: (): Record<string, three.Texture> => ({}),
      marker: "gpuBehavior: gpuKernel0,",
    },
  ])("still builds and spawns with $variant", ({ source, assets, marker }) => {
    const text = emitProjectModule(source());
    expect(text).toContain(marker);
    const Effect = loadModule(text)["Effect"] as new (
      assets: Record<string, three.Texture>,
    ) => three.Group & { play(): void; dispose(): void };
    const effect = new Effect(assets());
    try {
      effect.play();
      sparcoon.FXWorld.update(0.1);
      expect(totalParticles(effect)).toBe(32);
    } finally {
      effect.dispose();
    }
  });
});

describe("emitProjectModule - shadow flags", () => {
  it("emits castShadow/receiveShadow only when true (omit-when-false, like hidden)", () => {
    const both = emitProjectModule(emitterWithShadows(true, true));
    expect(both).toContain("castShadow: true,");
    expect(both).toContain("receiveShadow: true,");
  });

  it("omits both flags when absent or explicitly false", () => {
    const absent = emitProjectModule(createTestState().source);
    expect(absent).not.toContain("castShadow");
    expect(absent).not.toContain("receiveShadow");

    const explicitFalse = emitProjectModule(emitterWithShadows(false, false));
    expect(explicitFalse).not.toContain("castShadow");
    expect(explicitFalse).not.toContain("receiveShadow");
  });

  it("emits a mesh's shadow flags into its spec literal", () => {
    const base = createTestState().source;
    const seed = createDefaultVfxMesh("mesh_1", "Mesh");
    const mesh = { ...seed, renderGraph: withSinkShadow(seed.renderGraph, true, true) };
    const text = emitProjectModule({ ...base, scene: { ...base.scene, meshes: [mesh] } });
    expect(text).toContain("castShadow: true,");
    expect(text).toContain("receiveShadow: true,");
  });
});

/** `source` with every emitter's live channels and params dropped - its tracks all bake in. */
function withoutLiveness(source: SourceState): SourceState {
  const emitters = source.scene.emitters.map((emitter) => ({
    ...emitter,
    liveChannels: [],
    liveParams: [],
  }));
  return { ...source, scene: { ...source.scene, emitters } };
}

describe("emitProjectModule - fake tracks / live update", () => {
  it("never re-poses the root transform - the consumer positions the exported effect directly", () => {
    const module = loadModule(emitProjectModule(createTestState().source));
    const Effect = module["Effect"] as new (assets: Record<string, never>) => three.Group & {
      play(): void;
      dispose(): void;
    };
    const effect = new Effect({});
    try {
      effect.position.set(5, 6, 7);
      effect.play();
      sparcoon.FXWorld.update(0.1); // a baked (non-fake) root track would snap this back to the authored pose
      expect(effect.position.toArray()).toEqual([5, 6, 7]);
    } finally {
      effect.dispose();
    }
  });

  it("drops a fake transform track's keys and exposes the channel through getEmitter instead", () => {
    const source = fakePositionEmitterSource();
    const text = emitProjectModule(source);
    // The fake key's value never reaches the export, though the same key exports when not live.
    const fakeKey = '"value":[9,9,9]';
    expect(emitProjectModule(withoutLiveness(source))).toContain(fakeKey);
    expect(text).not.toContain(fakeKey);
    expect(text).toContain('liveChannels: ["position"]');
    expect(text).toContain('public override getEmitter(name: "Emitter"): FXEmitter | undefined;');

    const module = loadModule(text);
    const Effect = module["Effect"] as new (assets: Record<string, never>) => three.Group & {
      getEmitter(name: "Emitter"): three.Object3D | undefined;
      play(): void;
      dispose(): void;
    };
    const effect = new Effect({});
    try {
      const emitterObject = effect.getEmitter("Emitter");
      expect(emitterObject).toBeDefined();
      emitterObject!.position.set(1, 2, 3);
      effect.play();
      sparcoon.FXWorld.update(0.1); // a live channel must not be re-driven from the (dropped) fake track
      expect(emitterObject!.position.toArray()).toEqual([1, 2, 3]);
    } finally {
      effect.dispose();
    }
  });

  it("drops a fake Timeline Value track's keys and exposes it through setEmitterParam instead", () => {
    const source = fakeParamEmitterSource();
    const text = emitProjectModule(source);
    // The fake key's value never reaches the export, though the same key exports when not live.
    const fakeKey = '"value":[0.25,0.5,0.75,1]';
    expect(emitProjectModule(withoutLiveness(source))).toContain(fakeKey);
    expect(text).not.toContain(fakeKey);
    expect(text).toContain('liveParams: ["tint"]');
    expect(text).toContain(
      'public override setEmitterParam(name: "Emitter", parameter: "tint", value: number | readonly number[]): void;',
    );

    const module = loadModule(text);
    const Effect = module["Effect"] as new (assets: Record<string, never>) => three.Group & {
      setEmitterParam(name: "Emitter", parameter: "tint", value: readonly number[]): void;
      play(): void;
      dispose(): void;
    };
    const effect = new Effect({});
    try {
      expect(() => effect.setEmitterParam("Emitter", "tint", [0, 1, 0, 1])).not.toThrow();
    } finally {
      effect.dispose();
    }
  });

  it("marks a channel/param live before any keyframe exists, still excluded from export", () => {
    // Liveness is entity-level metadata (EmitterDoc.liveChannels/liveParams), not a track flag - a
    // channel/param can be marked live with zero authored keyframes, and stays excluded from the
    // export the moment it IS keyframed later, without ever depending on track existence.
    const base = createTestState().source;
    const emitter = base.scene.emitters[0];
    const source: SourceState = {
      ...base,
      scene: {
        ...base.scene,
        emitters: [{ ...emitter, liveChannels: ["scale"], liveParams: ["untouched"] }],
      },
    };
    const text = emitProjectModule(source);
    expect(text).toContain('liveChannels: ["scale"]');
    expect(text).toContain('liveParams: ["untouched"]');
    expect(text).toContain('public override getEmitter(name: "Emitter"): FXEmitter | undefined;');
    expect(text).toContain(
      'public override setEmitterParam(name: "Emitter", parameter: "untouched", value: number | readonly number[]): void;',
    );
  });

  it("ships no live events and leaves spawning to the host through getEmitter", () => {
    const base = createTestState().source;
    const emitter = base.scene.emitters[0];
    expect(emitter.events.length).toBeGreaterThan(0);
    const source: SourceState = {
      ...base,
      scene: { ...base.scene, emitters: [{ ...emitter, liveEvents: true }] },
    };
    const text = emitProjectModule(source);
    expect(text).toMatch(/^\s*events: \[\],$/m);
    expect(text).toContain("  type FXEmitter,");
    expect(text).toContain('public override getEmitter(name: "Emitter"): FXEmitter | undefined;');

    const module = loadModule(text);
    const Effect = module["Effect"] as new (assets: Record<string, never>) => three.Group & {
      getEmitter(name: "Emitter"): { burst(count: number): number } | undefined;
      play(): void;
      dispose(): void;
    };
    const effect = new Effect({});
    try {
      effect.play();
      sparcoon.FXWorld.update(0.1); // the editor's t=0 burst must not fire in the game
      expect(totalParticles(effect)).toBe(0);
      effect.getEmitter("Emitter")!.burst(5);
      sparcoon.FXWorld.update(0.1);
      expect(totalParticles(effect)).toBe(5);
    } finally {
      effect.dispose();
    }
  });

  it("getEmitter/setEmitterParam no-op after dispose instead of throwing", () => {
    const positionModule = loadModule(emitProjectModule(fakePositionEmitterSource()));
    const PositionEffect = positionModule["Effect"] as new (
      assets: Record<string, never>,
    ) => three.Group & {
      getEmitter(name: "Emitter"): three.Object3D | undefined;
      dispose(): void;
    };
    const positionEffect = new PositionEffect({});
    positionEffect.dispose();
    expect(() => positionEffect.getEmitter("Emitter")).not.toThrow();
    expect(positionEffect.getEmitter("Emitter")).toBeUndefined();

    const paramModule = loadModule(emitProjectModule(fakeParamEmitterSource()));
    const ParamEffect = paramModule["Effect"] as new (
      assets: Record<string, never>,
    ) => three.Group & {
      setEmitterParam(name: "Emitter", parameter: "tint", value: readonly number[]): void;
      dispose(): void;
    };
    const paramEffect = new ParamEffect({});
    paramEffect.dispose();
    expect(() => paramEffect.setEmitterParam("Emitter", "tint", [1, 1, 1, 1])).not.toThrow();
  });
});

describe("emitProjectModule - live meshes and name clashes", () => {
  /** One VFX mesh named `Shield` with a live `position` channel and a live `glow` value. */
  function liveMeshSource(): SourceState {
    const base = createTestState().source;
    const mesh = {
      ...createDefaultVfxMesh("mesh_1", "Shield"),
      transformTracks: [
        { channel: "position" as const, keys: [{ id: "k1", time: 0, value: [7, 7, 7] }] },
      ],
      tracks: [{ name: "glow", keys: [{ id: "k2", time: 0, value: 0.625 }] }],
      liveChannels: ["position" as const],
      liveParams: ["glow"],
    };
    return { ...base, scene: { ...base.scene, meshes: [mesh] } };
  }

  it("drops a live mesh's keys and types getMesh/setMeshParam for it", () => {
    const text = emitProjectModule(liveMeshSource());
    expect(text).not.toContain('"value":[7,7,7]');
    expect(text).not.toContain('"value":0.625');
    expect(text).toContain('public override getMesh(name: "Shield"): Mesh | undefined;');
    expect(text).toContain(
      'public override setMeshParam(name: "Shield", parameter: "glow", value: number | readonly number[]): void;',
    );
  });

  it("hands the host the mesh to pose, and never re-poses its live channel", () => {
    const Effect = loadModule(emitProjectModule(liveMeshSource()))["Effect"] as new (
      assets: Record<string, never>,
    ) => three.Group & {
      getMesh(name: "Shield"): three.Object3D | undefined;
      setMeshParam(name: "Shield", parameter: "glow", value: number): void;
      play(): void;
      dispose(): void;
    };
    const effect = new Effect({});
    try {
      const mesh = effect.getMesh("Shield");
      expect(mesh?.type).toBe("Mesh");
      mesh!.position.set(1, 2, 3);
      effect.play();
      sparcoon.FXWorld.update(0.1);
      expect(mesh!.position.toArray()).toEqual([1, 2, 3]);
      expect(() => effect.setMeshParam("Shield", "glow", 0.5)).not.toThrow();
    } finally {
      effect.dispose();
    }
  });

  it.each([
    ["both have", ["tint"], ["tint"]],
    ["only the first has", ["tint"], []],
    ["only the second has", [], ["tint"]],
  ])("refuses two emitters sharing a name when %s a live track", (_case, firstLive, twinLive) => {
    const base = createTestState().source;
    const first = { ...base.scene.emitters[0], liveParams: firstLive };
    const twin = { ...first, id: "emitter_2", liveParams: twinLive };
    const clash: SourceState = { ...base, scene: { ...base.scene, emitters: [first, twin] } };
    expect(() => emitProjectModule(clash)).toThrow(/two emitters are both named "Emitter"/);
  });

  it("lets two emitters share a name when neither has a live track", () => {
    const base = createTestState().source;
    const first = base.scene.emitters[0];
    const twin = { ...first, id: "emitter_2" };
    // Neither is addressed by name, so the clash is harmless.
    const plain = [first, twin].map((emitter) => ({ ...emitter, liveParams: [] }));
    expect(() =>
      emitProjectModule({ ...base, scene: { ...base.scene, emitters: plain } }),
    ).not.toThrow();
  });
});

describe("emitProjectModule - GPU (transform-feedback) simulation opt-in", () => {
  it("emits an FXParticleKernelArtifact block and references it from the spec when the flag is on, its default", () => {
    const text = emitProjectModule(emitterWithGpuFlag(true));
    // createTestState()'s spawn sink never sets the flag: it exports exactly as switched on.
    expect(emitProjectModule(createTestState().source)).toBe(text);
    // The default project's spawn graph (spawn-box + lifetime) is fully GLSL-portable (rand/cbrt/
    // fbm all have a standard-tier twin) - it must actually compile, not silently fall back, or
    // this test would be exercising the wrong branch.
    expect(text).toContain("const gpuKernel0: FXParticleKernelArtifact = {");
    expect(text).toContain("gpuBehavior: gpuKernel0,");
    expect(text).toContain("  type FXParticleKernelArtifact,");
    // The mandatory JS artifact is still present regardless - a GPU-opted-in emitter is never
    // left with only a GPU artifact and no fallback.
    expect(text).toContain("const behavior0: FXBehaviorArtifact = {");
    expect(text).toContain("behavior: behavior0,");
    // Real GLSL text, not a placeholder - loosely sanity-checked without a GLSL parser.
    expect(text).toContain("#version 300 es");
    expect(text).toContain("layout(location = 0) in");
  });

  it("omits the GPU artifact and its type import entirely when the flag is explicitly off", () => {
    const text = emitProjectModule(emitterWithGpuFlag(false));
    expect(text).not.toContain("FXParticleKernelArtifact");
    expect(text).not.toContain("gpuBehavior");
  });
});
