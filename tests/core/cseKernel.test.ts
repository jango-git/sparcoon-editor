import { describe, expect, it } from "vitest";
import type { FXConnection, FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import { registerStandardBehaviorNodes } from "../../src/engine/nodes-std/index";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import {
  buildParticleSpawnKernel,
  compileBehavior,
} from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import { buildParticleBehaviorTargets } from "../../src/engine/behavior/FXParticleBehaviorTarget";

// The behavior kernel runs a whole-phase CSE pass before printing (see cse.Internal.ts): a
// subtree shared across scalarized components is emitted once. These assert the two things
// that matter - it actually dedups, and it never merges `Math.random()` (which would collapse
// independent per-particle draws into one).

function bind(
  slot: string,
  nodeId: string,
  socketKey: string,
  phase: FXBehaviorPhase,
): FXOutputBinding {
  return { slot, from: { nodeId, socketKey }, phase };
}
function edge(fromNode: string, fromKey: string, toNode: string, toKey: string): FXConnection {
  return {
    from: { nodeId: fromNode, socketKey: fromKey },
    to: { nodeId: toNode, socketKey: toKey },
  };
}
function registry(): FXNodeRegistry<FXBehaviorNode> {
  const r = new FXNodeRegistry<FXBehaviorNode>();
  registerStandardBehaviorNodes(r);
  return r;
}

function spawnPhase(
  nodes: Map<string, FXBehaviorNode>,
  connections: readonly FXConnection[],
  terminal: string,
  socketKey = "out",
) {
  const graph = new FXGraph<FXBehaviorNode>();
  graph.ingest({
    nodes,
    connections,
    outputBindings: [bind("position", terminal, socketKey, FXBehaviorPhase.SPAWN)],
  });
  return compileBehavior(graph, buildParticleBehaviorTargets());
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("behavior kernel CSE", () => {
  it("emits a shared subexpression once, and hoists it when invariant (normalize's length)", () => {
    const r = registry();
    // normalize([3,4,0]) shares one `sqrt(x*x+y*y+z*z)` across x/y/z; being constant it is also
    // particle-invariant, so it hoists out of the loop entirely.
    const compiled = spawnPhase(
      new Map([
        ["c", r.create("constant", { type: "vec3", value: [3, 4, 0] })],
        ["n", r.create("unary-op", { op: "normalize" })],
      ]),
      [edge("c", "out", "n", "x")],
      "n",
    );
    const preLoop = compiled.spawn!.preLoop.join("\n");
    const body = compiled.spawn!.body.join("\n");
    // CSE: exactly one sqrt across the whole phase (not three).
    expect(occurrences(`${preLoop}\n${body}`, "Math.sqrt")).toBe(1);
    // Hoist: the invariant magnitude is computed before the loop, not per particle.
    expect(occurrences(preLoop, "Math.sqrt")).toBe(1);
    expect(occurrences(body, "Math.sqrt")).toBe(0);

    // ...and it still computes the right value.
    const spawn = buildParticleSpawnKernel(compiled);
    const buffers = { position: new Float32Array(3), lifecycle: new Float32Array(2) };
    spawn(buffers, 0, 1, compiled.spawn!.bindings);
    expect(buffers.position[0]).toBeCloseTo(0.6, 5);
    expect(buffers.position[1]).toBeCloseTo(0.8, 5);
    expect(buffers.position[2]).toBeCloseTo(0, 5);
  });

  it("never merges Math.random() (three independent axes stay three draws)", () => {
    const r = registry();
    // A filled spawn-box draws one independent random per axis; CSE must keep all three.
    const compiled = spawnPhase(
      new Map([["box", r.create("spawn-box", { size: [2, 2, 2], center: [0, 0, 0] })]]),
      [],
      "box",
      "position",
    );
    const body = compiled.spawn!.body.join("\n");
    expect(occurrences(body, "Math.random()")).toBe(3);
  });

  it("preserves per-particle decorrelation numerically after CSE", () => {
    const r = registry();
    const compiled = spawnPhase(
      new Map([["box", r.create("spawn-box", { size: [2, 2, 2], center: [0, 0, 0] })]]),
      [],
      "box",
      "position",
    );
    const spawn = buildParticleSpawnKernel(compiled);
    // If the three draws had merged, x==y==z every particle. Across samples they must differ.
    let anyAxisDiffers = false;
    for (let i = 0; i < 32 && !anyAxisDiffers; i += 1) {
      const buffers = { position: new Float32Array(3), lifecycle: new Float32Array(2) };
      spawn(buffers, 0, 1, compiled.spawn!.bindings);
      if (
        buffers.position[0] !== buffers.position[1] ||
        buffers.position[1] !== buffers.position[2]
      ) {
        anyAxisDiffers = true;
      }
    }
    expect(anyAxisDiffers).toBe(true);
  });
});
