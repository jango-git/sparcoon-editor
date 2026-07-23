import { describe, expect, it } from "vitest";
import { FXGraph } from "../../src/engine/core/FXGraph";
import type { FXConnection } from "../../src/engine/core/FXGraph";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import { buildParticleTarget } from "../../src/engine/render/target/FXParticleRenderTarget";
import {
  buildParticleSpawnKernel,
  buildParticleUpdateKernel,
  compileParticleBehavior,
} from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import type { FXCompiledKernel } from "../../src/engine/behavior/FXCompiledKernel";
import {
  fxDataTexture,
  FX_POSITION_Y,
  type FXBehaviorArtifact,
  type FXRenderArtifact,
} from "sparcoon";
import { FXEmitter } from "sparcoon/editor";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { behaviorRegistry, renderRegistry } from "../helpers/stdRegistry";
import { attributeSlot, readAttr, storeAttr } from "../helpers/attr";
import { emitEffectModule } from "../../src/engine/emit/emitEffectModule";

const VEC3 = FX_VALUE_TYPES.vec3;

function edge(fromNode: string, fromKey: string, toNode: string, toKey: string): FXConnection {
  return {
    from: { nodeId: fromNode, socketKey: fromKey },
    to: { nodeId: toNode, socketKey: toKey },
  };
}

/**
 * A deterministic gravity plume as two `FXGraph`s, in the executor model: velocity is a
 * user attribute (`store-attribute`/`read-attribute`) and motion is an explicit
 * `integrate-motion` node. Degenerate ranges (`[2,2]`, `[1,1]`) keep spawn deterministic
 * despite the inline `Math.random()` draws, so the equivalence check is byte-exact.
 */
function plumeGraphs(): { render: FXGraph<FXRenderNode>; behavior: FXGraph<FXBehaviorNode> } {
  const rr = renderRegistry();
  const render = new FXGraph<FXRenderNode>();
  render.ingest({
    nodes: new Map([["c", rr.create("constant", { type: "vec4", value: [0.6, 0.6, 0.7, 1] })]]),
    connections: [],
    outputBindings: [{ slot: "albedo", from: { nodeId: "c", socketKey: "out" } }],
  });

  const br = behaviorRegistry();
  const behavior = new FXGraph<FXBehaviorNode>();
  behavior.ingest({
    nodes: new Map<string, FXBehaviorNode>([
      // spawn: seed lifetime + position, store an initial velocity attribute.
      ["life", br.create("lifetime", { min: 2, max: 2 })],
      ["pos", br.create("spawn-box", { size: [0, 0, 0], center: [0, 0, 0] })],
      ["iv", br.create("initial-velocity", { direction: [0, 1, 0], speed: [1, 1] })],
      ["svs", storeAttr("velocity", VEC3, FXBehaviorPhase.SPAWN)],
      // update: accumulate velocity (gravity), then integrate position from it.
      ["rv", readAttr("velocity", VEC3)],
      ["g", br.create("gravity", { acceleration: [0, -9.8, 0] })],
      ["svu", storeAttr("velocity", VEC3)],
      ["im", br.create("integrate-motion")],
    ]),
    connections: [
      edge("iv", "velocity", "svs", "value"),
      edge("rv", "value", "g", "velocity"),
      edge("g", "velocity", "svu", "value"),
      edge("g", "velocity", "im", "velocity"),
    ],
    outputBindings: [
      { slot: "lifetime", from: { nodeId: "life", socketKey: "value" } },
      { slot: "position", from: { nodeId: "pos", socketKey: "position" } },
      { slot: attributeSlot("velocity"), from: { nodeId: "svs", socketKey: "value" } },
      { slot: attributeSlot("velocity"), from: { nodeId: "svu", socketKey: "value" } },
      { slot: "position", from: { nodeId: "im", socketKey: "position" } },
    ],
  });

  return { render, behavior };
}

/**
 * Evaluates an emitted module's text into its three artifacts, without a file/import: the
 * only TS annotations the emitter writes are the `: FX*Artifact` types and the import
 * line, all stripped here; `fxDataTexture` is supplied as the sole free variable.
 */
function evalModule(text: string): {
  renderBaseline: FXRenderArtifact;
  renderStandard: FXRenderArtifact;
  behavior: FXBehaviorArtifact;
} {
  const js =
    text
      .replace(/^import .*$/m, "")
      .replace(/: FXRenderArtifact\b/g, "")
      .replace(/: FXBehaviorArtifact\b/g, "")
      .replace(/\bexport const /g, "const ") +
    "\nreturn { renderBaseline, renderStandard, behavior };";

  const factory = new Function("fxDataTexture", js) as (t: typeof fxDataTexture) => {
    renderBaseline: FXRenderArtifact;
    renderStandard: FXRenderArtifact;
    behavior: FXBehaviorArtifact;
  };
  return factory(fxDataTexture);
}

const COUNT = 3;
const DT = 0.016;

/** Allocates one buffer per state buffer the kernel declares (core + attributes). */
function buffersFor(kernel: FXCompiledKernel, count: number): Record<string, Float32Array> {
  const buffers: Record<string, Float32Array> = {};
  for (const buffer of kernel.update.buffers) {
    buffers[buffer.name] = new Float32Array(buffer.stride * count);
  }
  return buffers;
}

/** The minimal shape `meshOf` needs from `FXEmitter`'s private `mesh` field - reading it this way,
 *  instead of importing the runtime's internal `FXInstancedParticle` type, keeps the test off the
 *  package boundary's non-public surface. */
interface ParticleMesh {
  readonly propertyBuffers: Record<string, { readonly array: Float32Array }>;
}

function meshOf(emitter: FXEmitter): ParticleMesh {
  return (emitter as unknown as { mesh: ParticleMesh }).mesh;
}

describe("emitEffectModule - round-trip", () => {
  it("emits a well-formed module (import, both artifacts, authored spawn/update)", () => {
    const { render, behavior } = plumeGraphs();
    const text = emitEffectModule(render, behavior);

    expect(text).toContain('from "sparcoon"');
    expect(text).toContain("export const renderBaseline: FXRenderArtifact = {");
    expect(text).toContain("export const renderStandard: FXRenderArtifact = {");
    expect(text).toContain("export const behavior: FXBehaviorArtifact = {");
    expect(text).toContain("spawn(buffers, start, count, bindings, emitter) {");
    expect(text).toContain("update(buffers, count, dt, bindings, emitter) {");
    expect(text).toContain("lightingIntrinsics: []");
  });

  it("threads renderMode into the emitted render artifact options", () => {
    const { render, behavior } = plumeGraphs();

    // Regression: the emitted module used to omit `options` entirely, silently dropping the
    // render mode the compileToArtifacts preview path honors - the two paths disagreed.
    // Checked on both targets - renderMode/options are tier-independent.
    const off = evalModule(emitEffectModule(render, behavior));
    const on = evalModule(emitEffectModule(render, behavior, { renderMode: "alphaHash" }));

    expect(off.renderBaseline.options).toEqual({ renderMode: "blending" });
    expect(off.renderStandard.options).toEqual({ renderMode: "blending" });
    expect(on.renderBaseline.options).toEqual({ renderMode: "alphaHash" });
    expect(on.renderStandard.options).toEqual({ renderMode: "alphaHash" });
  });

  it("the emitted render artifact matches a direct compile (baseline)", () => {
    const { render, behavior } = plumeGraphs();
    const shader = new FXCompilerBaseline().compile(render, buildParticleTarget([]));
    const emitted = evalModule(emitEffectModule(render, behavior)).renderBaseline;

    expect(emitted.lightingIntrinsics).toEqual([]);
    expect(emitted.uniformDeclarations).toEqual(shader.uniformDeclarations);
    expect(emitted.vertex.body).toEqual(shader.vertex.body);
    expect(emitted.fragment.body).toEqual(shader.fragment.body);
    expect(emitted.outputs).toEqual(shader.outputs);
    expect(emitted.attributeReads).toEqual([]);
  });

  it("the emitted behavior artifact carries the same buffer layout + written set", () => {
    const { render, behavior } = plumeGraphs();
    const kernel = compileParticleBehavior(behavior);
    const emitted = evalModule(emitEffectModule(render, behavior)).behavior;

    expect(emitted.buffers).toEqual(kernel.update.buffers);
    expect(emitted.updateWrittenBuffers).toEqual(kernel.update.writtenBuffers);
    expect(emitted.spawnWrittenBuffers).toEqual(kernel.spawn?.writtenBuffers);
    // velocity is a real attribute now.
    expect(emitted.attributeWrites).toEqual([{ name: "velocity", components: 3 }]);
  });

  it("the emitted spawn/update simulate identically to a direct compile (equivalence)", () => {
    const { render, behavior } = plumeGraphs();
    const kernel = compileParticleBehavior(behavior);
    const directSpawn = buildParticleSpawnKernel(kernel);
    const directUpdate = buildParticleUpdateKernel(kernel);

    const direct = buffersFor(kernel, COUNT);
    directSpawn(direct, 0, COUNT, kernel.spawn?.bindings ?? {});
    directUpdate(direct, COUNT, DT, kernel.update.bindings);

    const emitted = evalModule(emitEffectModule(render, behavior)).behavior;
    const viaModule = buffersFor(kernel, COUNT);
    emitted.spawn?.(viaModule, 0, COUNT, emitted.bindings);
    emitted.update(viaModule, COUNT, DT, emitted.bindings);

    for (const name of Object.keys(direct)) {
      expect([...viaModule[name]], name).toEqual([...direct[name]]);
    }
    // Sanity: the plume moved (position advanced, velocity accumulated).
    expect(viaModule.position.some((v) => v !== 0)).toBe(true);
    expect(viaModule.velocity.some((v) => v !== 0)).toBe(true);
  });
});

describe("emitEffectModule - full golden (graph -> module -> fromArtifacts executes)", () => {
  it("an emitted module launches through FXEmitter.fromArtifacts and simulates", () => {
    const { render, behavior } = plumeGraphs();
    const artifacts = evalModule(emitEffectModule(render, behavior));

    const emitter = FXEmitter.fromArtifacts(artifacts.renderBaseline, artifacts.behavior);
    try {
      emitter.burst(4);
      expect(emitter.particleCount).toBe(4);

      const position = meshOf(emitter).propertyBuffers.position.array;
      expect(position[FX_POSITION_Y]).toBe(0); // born at the origin

      // A few frames: gravity accumulates velocity, integrate-motion advances position,
      // particles stay alive (lifetime 2). The whole graph->module->runtime path executes.
      emitter.prewarm(0.2);
      expect(emitter.particleCount).toBe(4);
      expect(meshOf(emitter).propertyBuffers.position.array[FX_POSITION_Y]).not.toBe(0);
    } finally {
      emitter.destroy();
    }
  });
});
