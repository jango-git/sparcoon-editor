import { describe, expect, it } from "vitest";
import * as ts from "typescript";
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
import { createTestState } from "../helpers/testDocument";

/**
 * Transpiles an emitted TS project module to CJS and evaluates it with the real `sparcoon` + `three`
 * (resolved through the test's own imports), returning its exports - the runtime path a consumer
 * gets, minus the bundler.
 */
function loadModule(text: string): Record<string, unknown> {
  const js = ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const shimExports: Record<string, unknown> = {};
  const shimModule = { exports: shimExports };
  const shimRequire = (id: string): unknown => {
    if (id === "three") {
      return three;
    }
    if (id === "sparcoon") {
      return sparcoon;
    }
    throw new Error(`unexpected import "${id}"`);
  };

  new Function("require", "exports", "module", js)(shimRequire, shimExports, shimModule);
  return shimModule.exports;
}

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
    expect(text).toContain("const render0Standard: FXRenderArtifact = {");
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
    expect(text).toContain("const render1Standard: FXRenderArtifact = {");
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

  it("binds an external texture supplied to the constructor", () => {
    const module = loadModule(emitProjectModule(textureEmitterSource()));
    const Effect = module["Effect"] as new (assets: { sprite: three.Texture }) => three.Group & {
      play(): void;
      dispose(): void;
    };
    const effect = new Effect({ sprite: new three.Texture() });
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
  // castShadow/receiveShadow live on the render graph's surface sink (like geometry/sortInterval),
  // so drive them through the sink node's parameters, not an entity-level field.
  const withSinkShadow = (graph: EditorGraph, cast?: boolean, receive?: boolean): EditorGraph => {
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
  };

  const emitterWithShadows = (cast?: boolean, receive?: boolean): SourceState => {
    const base = createTestState().source;
    const emitter = base.scene.emitters[0];
    return {
      ...base,
      scene: {
        ...base.scene,
        emitters: [{ ...emitter, renderGraph: withSinkShadow(emitter.renderGraph, cast, receive) }],
      },
    };
  };

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

  it("a cast-shadow emitter still builds and spawns at runtime", () => {
    const module = loadModule(emitProjectModule(emitterWithShadows(true, true)));
    const Effect = module["Effect"] as new (assets: Record<string, never>) => three.Group & {
      play(): void;
      dispose(): void;
    };
    const effect = new Effect({});
    try {
      effect.play();
      sparcoon.FXWorld.update(0.1);
      expect(totalParticles(effect)).toBe(32);
    } finally {
      effect.dispose();
    }
  });
});

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
    const text = emitProjectModule(fakePositionEmitterSource());
    expect(text).not.toContain("9,9,9"); // the fake key's value must never reach the export
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
    const text = emitProjectModule(fakeParamEmitterSource());
    expect(text).not.toContain("0.25"); // the fake key's value must never reach the export
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

describe("emitProjectModule - GPU (transform-feedback) simulation opt-in", () => {
  // "Try GPU simulation" lives on the behavior graph's spawn sink, like castShadow/receiveShadow
  // live on the render graph's surface sink - same read-a-sink-parameter pattern.
  const withTryGpuSimulation = (graph: EditorGraph, on: boolean): EditorGraph => {
    const sink = graph.nodes[SPAWN_SINK_ID];
    return {
      ...graph,
      nodes: {
        ...graph.nodes,
        [SPAWN_SINK_ID]: {
          ...sink,
          parameters: { ...sink.parameters, [SPAWN_TRY_GPU_SIMULATION_PARAM]: on },
        },
      },
    };
  };

  const emitterWithGpuFlag = (on: boolean): SourceState => {
    const base = createTestState().source;
    const emitter = base.scene.emitters[0];
    return {
      ...base,
      scene: {
        ...base.scene,
        emitters: [{ ...emitter, behaviorGraph: withTryGpuSimulation(emitter.behaviorGraph, on) }],
      },
    };
  };

  it("emits an FXParticleKernelArtifact block and references it from the spec when the flag is on", () => {
    const text = emitProjectModule(emitterWithGpuFlag(true));
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

  it("includes the GPU artifact by default (Try GPU simulation defaults on)", () => {
    // No override - createTestState()'s spawn sink never has the flag explicitly set.
    const text = emitProjectModule(createTestState().source);
    expect(text).toContain("FXParticleKernelArtifact");
    expect(text).toContain("gpuBehavior");
  });

  it("omits the GPU artifact and its type import entirely when the flag is explicitly off", () => {
    const text = emitProjectModule(emitterWithGpuFlag(false));
    expect(text).not.toContain("FXParticleKernelArtifact");
    expect(text).not.toContain("gpuBehavior");
  });

  it("the exported module still builds and spawns at runtime with the flag on (no renderer supplied,\
 so the mandatory JS fallback is what actually drives it)", () => {
    const module = loadModule(emitProjectModule(emitterWithGpuFlag(true)));
    const Effect = module["Effect"] as new (assets: Record<string, never>) => three.Group & {
      play(): void;
      dispose(): void;
    };
    const effect = new Effect({});
    try {
      effect.play();
      sparcoon.FXWorld.update(0.1);
      expect(totalParticles(effect)).toBe(32);
    } finally {
      effect.dispose();
    }
  });
});
