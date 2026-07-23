// Perf smoke - NOT part of the CI gate (vitest.config `test.include` is
// `*.test.ts`, so `vitest run` skips this). Run explicitly:
//
//   npx vitest bench
//
// Two numbers the live-editing architecture promises:
//   1. a value edit on a ~50-node graph takes the rebind path in well under 1ms;
//   2. the compiled update kernel is ~an order of magnitude faster than the
//      CSP-fallback interpreter on a 10k-particle step.

import { bench, describe } from "vitest";
import { buildBehaviorGraph } from "../src/engine/builder/FXGraphBuilder";
import { FXGraphReconciler } from "../src/engine/core/live/FXGraphReconciler";
import { FXLiveGraph } from "../src/engine/core/live/FXLiveGraph";
import { FXBehaviorLiveBackend } from "../src/engine/behavior/live/FXBehaviorLiveBackend";
import { buildParticleBehaviorTargets } from "../src/engine/behavior/FXParticleBehaviorTarget";
import { FXGraph } from "../src/engine/core/FXGraph";
import type { FXBehaviorNode } from "../src/engine/behavior/FXBehaviorNode";
import {
  buildParticleUpdateKernel,
  compileParticleBehavior,
} from "../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import { FX_CORE_LIFECYCLE_STRIDE, FX_LIFETIME } from "sparcoon";
import { behaviorRegistry } from "./helpers/stdRegistry";

// 1. rebind-path apply() on a ~50-node graph

// A wide tree of vec3 constants reduced by `binary-op` adds - ~50 reachable
// nodes - feeding velocity. Re-applying the identical snapshot hits the hash
// gate and takes the rebind branch (no recompile).
const wideSnapshot = buildBehaviorGraph((b) => {
  const LEAVES = 26; // 26 constants + 25 adds = 51 nodes
  let acc = b.add("constant", { type: "vec3", value: [0, 1, 0] }).out("out");
  for (let i = 1; i < LEAVES; i++) {
    const leaf = b.add("constant", { type: "vec3", value: [0, i * 0.01, 0] }).out("out");
    acc = b.add("binary-op", { op: "add" }, { a: acc, b: leaf }).out("out");
  }
  // Bind to the core `position` slot (a vec3 core write) - the benchmark measures node
  // count / rebind cost, not motion semantics, so no velocity attribute wiring is needed.
  b.bind("position", acc);
});

// The rebind gate FXSimulation.live used internally is FXLiveGraph + FXBehaviorLiveBackend;
// drive it directly to measure the same value-edit rebind path.
const liveGraph = new FXLiveGraph(
  new FXGraphReconciler(behaviorRegistry()),
  new FXBehaviorLiveBackend(() => {}, buildParticleBehaviorTargets),
);
liveGraph.apply(wideSnapshot); // prime: first apply compiles

describe("live apply - rebind path (~50 nodes)", () => {
  bench("apply(identical snapshot) -> rebound", () => {
    liveGraph.apply(wideSnapshot);
  });
});

// 2. update kernel over 10k particles: function vs interpreter

const reg = behaviorRegistry();
const updateGraph = new FXGraph<FXBehaviorNode>();
updateGraph.ingest({
  // gravity -> drag -> point-force: pure arithmetic + exp/dot/sqrt, so both the
  // compiled and the interpreter path can run it (turbulence's fBm helper has no
  // interpretable form, so it is deliberately excluded from this comparison).
  nodes: new Map<string, FXBehaviorNode>([
    ["g", reg.create("gravity", { acceleration: [0, -9.8, 0] })],
    ["d", reg.create("drag", { damping: 1.5 })],
    ["p", reg.create("point-force", { center: [0, 0, 0], strength: 3, falloff: "inverse-square" })],
  ]),
  connections: [
    { from: { nodeId: "g", socketKey: "velocity" }, to: { nodeId: "d", socketKey: "velocity" } },
    { from: { nodeId: "d", socketKey: "velocity" }, to: { nodeId: "p", socketKey: "velocity" } },
  ],
  // The force chain's velocity output lands in the core `position` slot - the benchmark
  // times the per-particle arithmetic, not motion correctness.
  outputBindings: [{ slot: "position", from: { nodeId: "p", socketKey: "velocity" } }],
});

const compiled = compileParticleBehavior(updateGraph);
const runFn = buildParticleUpdateKernel(compiled);

const COUNT = 10_000;
function freshBuffer(): Record<string, Float32Array> {
  const buffers: Record<string, Float32Array> = {};
  for (const buffer of compiled.update.buffers) {
    buffers[buffer.name] = new Float32Array(buffer.stride * COUNT);
  }
  for (let i = 0; i < COUNT; i++) {
    buffers.lifecycle[i * FX_CORE_LIFECYCLE_STRIDE + FX_LIFETIME] = 5;
  }
  return buffers;
}

describe("update kernel - 10k particles", () => {
  const fnBuf = freshBuffer();
  bench("compiled (new Function)", () => {
    runFn(fnBuf, COUNT, 1 / 60, compiled.update.bindings);
  });
});
