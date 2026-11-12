import { expect } from "vitest";
import { FX_POSITION_Y, FXWorld, type FXBehaviorArtifact, type FXRenderArtifact } from "sparcoon";
import { FXEmitter } from "sparcoon/editor";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import {
  buildParticleSpawnKernel,
  buildParticleUpdateKernel,
  compileParticleBehavior,
} from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import { buildParticleTarget } from "../../src/engine/render/target/FXParticleRenderTarget";
import { attributeSlot, readAttr, storeAttr } from "./attr";
import { edge } from "./graphBuild";
import { behaviorRegistry, renderRegistry } from "./stdRegistry";
import type { FXSlotLayout } from "sparcoon/editor";
import { slotOf, splitFields, type FieldBuffers } from "./slots";

/**
 * A deterministic gravity plume and the checks both artifact paths (`compileToArtifacts` in
 * memory, `emitEffectModule` as module text) must pass on it: each path's artifacts must agree
 * with a direct compile of the same graphs, and must launch and simulate in the runtime.
 */

const VEC3 = FX_VALUE_TYPES.vec3;
const COUNT = 3;
const DT = 0.016;

/**
 * The plume as two `FXGraph`s, in the executor model: velocity is a user attribute
 * (`store-attribute`/`custom-attribute`) and motion is an explicit `integrate-motion` node.
 * Degenerate ranges (`[2,2]`, `[1,1]`) keep spawn deterministic despite the inline
 * `Math.random()` draws, so the equivalence checks are exact.
 */
export function plumeGraphs(): {
  render: FXGraph<FXRenderNode>;
  behavior: FXGraph<FXBehaviorNode>;
} {
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

/** The minimal shape read from `FXEmitter`'s private `mesh` getter - reading it this way, instead
 *  of importing the runtime's internal `FXInstancedParticle` type, keeps the test off the package
 *  boundary's non-public surface. */
interface ParticleMesh {
  readonly slot: FXSlotLayout;
  readonly slots: Float32Array;
}

function particleY(emitter: FXEmitter): number | undefined {
  const { slot, slots } = (emitter as unknown as { mesh: ParticleMesh }).mesh;
  const position = slot.fields.find((field) => field.name === "position");
  return position === undefined ? undefined : slots[position.offset + FX_POSITION_Y];
}

/** The render artifact carries exactly what a direct baseline compile of the plume produces. */
export function expectPlumeRenderMatchesDirectCompile(
  artifact: FXRenderArtifact,
  render: FXGraph<FXRenderNode>,
): void {
  const shader = new FXCompilerBaseline().compile(render, buildParticleTarget([]));
  expect(artifact.lightingIntrinsics).toEqual([]);
  expect(artifact.vertex.uniformDeclarations).toEqual(shader.vertex.uniformDeclarations);
  expect(artifact.fragment.uniformDeclarations).toEqual(shader.fragment.uniformDeclarations);
  expect(artifact.vertex.body).toEqual(shader.vertex.body);
  expect(artifact.fragment.body).toEqual(shader.fragment.body);
  expect(artifact.outputs).toEqual(shader.outputs);
  expect(artifact.attributeReads).toEqual([]);
}

/** The behavior artifact declares the direct kernel's slot. */
export function expectPlumeBehaviorLayoutMatchesKernel(
  artifact: FXBehaviorArtifact,
  behavior: FXGraph<FXBehaviorNode>,
): void {
  const kernel = compileParticleBehavior(behavior);
  expect(artifact.buffers).toEqual(kernel.update.buffers);
  expect(artifact.buffers.map((buffer) => buffer.name)).toContain("velocity");
}

/** One spawn + one update through the artifact leaves the slots exactly as the direct kernel
 *  does, and the plume actually moved (position advanced, velocity accumulated). */
export function expectPlumeSimulatesLikeDirectCompile(
  artifact: FXBehaviorArtifact,
  behavior: FXGraph<FXBehaviorNode>,
): void {
  const kernel = compileParticleBehavior(behavior);
  const slot = slotOf(kernel.update.buffers);
  const direct = new Float32Array(slot.stride * COUNT);
  buildParticleSpawnKernel(kernel)(direct, 0, COUNT, kernel.spawn?.bindings ?? {});
  buildParticleUpdateKernel(kernel)(direct, COUNT, DT, kernel.update.bindings);

  const viaArtifact = new Float32Array(slot.stride * COUNT);
  artifact.spawn?.(viaArtifact, 0, COUNT, artifact.bindings);
  artifact.update(viaArtifact, COUNT, DT, artifact.bindings);

  expect([...viaArtifact]).toEqual([...direct]);
  const fields: FieldBuffers = {};
  splitFields(slot, viaArtifact, fields);
  expect(fields.position.some((value) => value !== 0)).toBe(true);
  expect(fields.velocity.some((value) => value !== 0)).toBe(true);
}

/** The artifact pair launches through `FXEmitter.fromArtifacts`: a burst is born at the origin,
 *  and a few frames of gravity + integrate-motion move it while it stays alive (lifetime 2). */
export function expectPlumeLaunchesAndSimulates(
  renderArtifact: FXRenderArtifact,
  behaviorArtifact: FXBehaviorArtifact,
): void {
  const emitter = FXEmitter.fromArtifacts(renderArtifact, behaviorArtifact);
  try {
    emitter.burst(4);
    FXWorld.update(0); // births land in a tick; a paused one seeds without simulating
    expect(emitter.particleCount).toBe(4);
    expect(particleY(emitter)).toBe(0);

    emitter.prewarm(0.2);
    expect(emitter.particleCount).toBe(4);
    expect(particleY(emitter)).not.toBe(0);
  } finally {
    emitter.destroy();
  }
}
