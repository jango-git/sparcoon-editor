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
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { FXEmitter } from "sparcoon/editor";
import { FX_POSITION_Y } from "sparcoon";
import { behaviorRegistry, renderRegistry } from "../helpers/stdRegistry";
import { attributeSlot, readAttr, readAttrRender, storeAttr } from "../helpers/attr";
import {
  compileToArtifacts,
  collectValues,
  validateArtifacts,
} from "../../src/engine/emit/compileToArtifacts";

const VEC3 = FX_VALUE_TYPES.vec3;

function edge(fromNode: string, fromKey: string, toNode: string, toKey: string): FXConnection {
  return {
    from: { nodeId: fromNode, socketKey: fromKey },
    to: { nodeId: toNode, socketKey: toKey },
  };
}

/** The same deterministic gravity plume as the emitEffectModule golden test. */
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
      ["life", br.create("lifetime", { min: 2, max: 2 })],
      ["pos", br.create("spawn-box", { size: [0, 0, 0], center: [0, 0, 0] })],
      ["iv", br.create("initial-velocity", { direction: [0, 1, 0], speed: [1, 1] })],
      ["svs", storeAttr("velocity", VEC3, FXBehaviorPhase.SPAWN)],
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

const COUNT = 3;
const DT = 0.016;

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

describe("compileToArtifacts", () => {
  it("the render artifact matches a direct compile", () => {
    const { render, behavior } = plumeGraphs();
    const shader = new FXCompilerBaseline().compile(render, buildParticleTarget([]));
    const artifact = compileToArtifacts(render, behavior).render;

    expect(artifact.lightingIntrinsics).toEqual([]);
    expect(artifact.uniformDeclarations).toEqual(shader.uniformDeclarations);
    expect(artifact.vertex.body).toEqual(shader.vertex.body);
    expect(artifact.fragment.body).toEqual(shader.fragment.body);
    expect(artifact.outputs).toEqual(shader.outputs);
    expect(artifact.attributeReads).toEqual([]);
  });

  it("threads renderMode into the render artifact options and the rebuild hash", () => {
    const { render, behavior } = plumeGraphs();

    const off = compileToArtifacts(render, behavior);
    const on = compileToArtifacts(render, behavior, { renderMode: "alphaHash" });

    // The option reaches the runtime-consumed artifact field (default `blending`)...
    expect(off.render.options).toEqual({ renderMode: "blending" });
    expect(on.render.options).toEqual({ renderMode: "alphaHash" });
    // ...and moves the hash, so changing it is treated as structural (a rebuild, not a rebind).
    expect(on.hash).not.toBe(off.hash);
    // Same inputs still hash identically (the fold is deterministic).
    expect(compileToArtifacts(render, behavior).hash).toBe(off.hash);
  });

  it("the behavior artifact carries the same buffer layout + written set", () => {
    const { render, behavior } = plumeGraphs();
    const kernel = compileParticleBehavior(behavior);
    const artifact = compileToArtifacts(render, behavior).behavior;

    expect(artifact.buffers).toEqual(kernel.update.buffers);
    expect(artifact.updateWrittenBuffers).toEqual(kernel.update.writtenBuffers);
    expect(artifact.spawnWrittenBuffers).toEqual(kernel.spawn?.writtenBuffers);
    expect(artifact.attributeWrites).toEqual([{ name: "velocity", components: 3 }]);
  });

  it("spawn/update simulate identically to a direct compile (equivalence)", () => {
    const { render, behavior } = plumeGraphs();
    const kernel = compileParticleBehavior(behavior);
    const directSpawn = buildParticleSpawnKernel(kernel);
    const directUpdate = buildParticleUpdateKernel(kernel);

    const direct = buffersFor(kernel, COUNT);
    directSpawn(direct, 0, COUNT, kernel.spawn?.bindings ?? {});
    directUpdate(direct, COUNT, DT, kernel.update.bindings);

    const artifact = compileToArtifacts(render, behavior).behavior;
    const viaArtifact = buffersFor(kernel, COUNT);
    artifact.spawn?.(viaArtifact, 0, COUNT, artifact.bindings);
    artifact.update(viaArtifact, COUNT, DT, artifact.bindings);

    for (const name of Object.keys(direct)) {
      expect([...viaArtifact[name]], name).toEqual([...direct[name]]);
    }
    expect(viaArtifact.position.some((v) => v !== 0)).toBe(true);
    expect(viaArtifact.velocity.some((v) => v !== 0)).toBe(true);
  });

  it("launches through FXEmitter.fromArtifacts and simulates", () => {
    const { render, behavior } = plumeGraphs();
    const { render: renderArtifact, behavior: behaviorArtifact } = compileToArtifacts(
      render,
      behavior,
    );

    const emitter = FXEmitter.fromArtifacts(renderArtifact, behaviorArtifact);
    try {
      emitter.burst(4);
      expect(emitter.particleCount).toBe(4);
      expect(meshOf(emitter).propertyBuffers.position.array[FX_POSITION_Y]).toBe(0);

      emitter.prewarm(0.2);
      expect(emitter.particleCount).toBe(4);
      expect(meshOf(emitter).propertyBuffers.position.array[FX_POSITION_Y]).not.toBe(0);
    } finally {
      emitter.destroy();
    }
  });

  it("collectValues projects the same slots the artifact declares (rebind channel)", () => {
    const { render, behavior } = plumeGraphs();
    const artifacts = compileToArtifacts(render, behavior);
    const values = collectValues(render, behavior);

    // uniform value slots match the render artifact's uniform names
    expect(Object.keys(values.uniforms ?? {}).sort()).toEqual(
      Object.keys(artifacts.render.uniforms).sort(),
    );
    // binding value slots match the behavior artifact's binding names
    expect(Object.keys(values.bindings ?? {}).sort()).toEqual(
      Object.keys(artifacts.behavior.bindings).sort(),
    );
    // and the values are the raw numbers/arrays, not {value} wrappers
    for (const [name, slot] of Object.entries(artifacts.behavior.bindings)) {
      expect(values.bindings?.[name]).toEqual(slot.value);
    }
  });
});

/** A behavior graph whose two gravity nodes feed each other's velocity - a dependency cycle. */
function cyclicBehaviorGraph(): FXGraph<FXBehaviorNode> {
  const br = behaviorRegistry();
  const behavior = new FXGraph<FXBehaviorNode>();
  behavior.ingest({
    nodes: new Map<string, FXBehaviorNode>([
      ["life", br.create("lifetime", { min: 2, max: 2 })],
      ["pos", br.create("spawn-box", { size: [0, 0, 0], center: [0, 0, 0] })],
      ["g1", br.create("gravity", { acceleration: [0, -9.8, 0] })],
      ["g2", br.create("gravity", { acceleration: [0, -9.8, 0] })],
      ["im", br.create("integrate-motion")],
      ["svu", storeAttr("velocity", VEC3)],
    ]),
    connections: [
      edge("g1", "velocity", "g2", "velocity"),
      edge("g2", "velocity", "g1", "velocity"),
      edge("g2", "velocity", "im", "velocity"),
      edge("g2", "velocity", "svu", "value"),
    ],
    outputBindings: [
      { slot: "lifetime", from: { nodeId: "life", socketKey: "value" } },
      { slot: "position", from: { nodeId: "pos", socketKey: "position" } },
      { slot: "position", from: { nodeId: "im", socketKey: "position" } },
      { slot: attributeSlot("velocity"), from: { nodeId: "svu", socketKey: "value" } },
    ],
  });
  return behavior;
}

describe("validateArtifacts", () => {
  it("reports no problems for a graph pair that compiles", () => {
    const { render, behavior } = plumeGraphs();
    const validation = validateArtifacts(render, behavior);

    expect(validation.render).toEqual([]);
    expect(validation.behavior).toEqual([]);
  });

  it("collects the failing graph's node-attributed problems (the highlight source)", () => {
    // A valid render graph paired with a cyclic behavior graph: only the behavior graph is
    // blamed, and its errors carry the node ids the canvas lights up.
    const { render } = plumeGraphs();
    const validation = validateArtifacts(render, cyclicBehaviorGraph());

    expect(validation.render).toEqual([]);
    expect(validation.behavior.length).toBeGreaterThan(0);
    expect(validation.behavior.some((error) => error.nodeId !== undefined)).toBe(true);
  });
});

/**
 * The render graph reads `shared` as vec4 while the behavior graph writes it as vec2. Neither
 * graph can see the disagreement alone - each is validated against a target built from its own
 * attribute set - so the check must span the two.
 */
function conflictingAttributeGraphs(): {
  render: FXGraph<FXRenderNode>;
  behavior: FXGraph<FXBehaviorNode>;
} {
  const render = new FXGraph<FXRenderNode>();
  render.ingest({
    nodes: new Map<string, FXRenderNode>([["ra", readAttrRender("shared", FX_VALUE_TYPES.vec4)]]),
    connections: [],
    outputBindings: [{ slot: "albedo", from: { nodeId: "ra", socketKey: "value" } }],
  });

  const br = behaviorRegistry();
  const behavior = new FXGraph<FXBehaviorNode>();
  behavior.ingest({
    nodes: new Map<string, FXBehaviorNode>([
      ["life", br.create("lifetime", { min: 2, max: 2 })],
      ["pos", br.create("spawn-box", { size: [0, 0, 0], center: [0, 0, 0] })],
      ["sv", storeAttr("shared", FX_VALUE_TYPES.vec2, FXBehaviorPhase.SPAWN)],
    ]),
    connections: [],
    outputBindings: [
      { slot: "lifetime", from: { nodeId: "life", socketKey: "value" } },
      { slot: "position", from: { nodeId: "pos", socketKey: "position" } },
      { slot: attributeSlot("shared"), from: { nodeId: "sv", socketKey: "value" } },
    ],
  });
  return { render, behavior };
}

describe("compileToArtifacts - cross-graph attribute conflict", () => {
  it("compileToArtifacts throws rather than emitting a mismatched buffer layout", () => {
    const { render, behavior } = conflictingAttributeGraphs();
    expect(() => compileToArtifacts(render, behavior)).toThrow(/shared/);
  });

  it("validateArtifacts surfaces the conflict on the behavior/writer side", () => {
    const { render, behavior } = conflictingAttributeGraphs();
    const validation = validateArtifacts(render, behavior);
    expect(validation.behavior.some((error) => error.code === "attribute-type-conflict")).toBe(
      true,
    );
  });
});
