import { describe, expect, it } from "vitest";
import type { FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import { registerStandardBehaviorNodes } from "../../src/engine/nodes-std/index";
import { defineNode } from "../../src/engine/core/nodes/defineNode";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import { compileBehavior } from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import { compileBehaviorStandard } from "../../src/engine/behavior/FXParticleBehaviorKernelStandard.Internal";
import { compileBehaviorBundle } from "../../src/engine/behavior/FXCompiledBehaviorBundle";
import { buildParticleBehaviorTargets } from "../../src/engine/behavior/FXParticleBehaviorTarget";

// compileBehaviorBundle is the one place that knows more than one simulation family exists - these
// tests exercise the orchestrator itself, not either family's own compiler (those are covered by
// behaviorCompile.test.ts / behaviorKernelStandard.test.ts).

function bind(
  slot: string,
  nodeId: string,
  socketKey: string,
  phase: FXBehaviorPhase,
): FXOutputBinding {
  return { slot, from: { nodeId, socketKey }, phase };
}

function registry(): FXNodeRegistry<FXBehaviorNode> {
  const r = new FXNodeRegistry<FXBehaviorNode>();
  registerStandardBehaviorNodes(r);
  return r;
}

function spawnBoxGraph(): FXGraph<FXBehaviorNode> {
  const r = registry();
  const graph = new FXGraph<FXBehaviorNode>();
  graph.ingest({
    nodes: new Map([["box", r.create("spawn-box", { size: [2, 2, 2], center: [0, 0, 0] })]]),
    connections: [],
    outputBindings: [bind("position", "box", "position", FXBehaviorPhase.SPAWN)],
  });
  return graph;
}

function jsOnlyGraph(): FXGraph<FXBehaviorNode> {
  // sampleLut (curve/LUT sampling) has no GLSL twin - a minimal graph that is valid JS but not
  // GLSL-portable, mirroring behaviorKernelStandard.test.ts's own fixture for the same reason.
  const jsOnlyNode = defineNode({
    type: "test-js-only-lut-sample",
    domain: "behavior",
    phase: "spawn",
    phaseFlexible: true,
    category: "source",
    inputs: {},
    outputs: { out: { type: "float" } },
    params: {},
    cost: 1,
    build: ({ fn }) => ({ out: fn.call("sampleLut", fn.lit(0), fn.lit(0)) }),
  });
  const r = registry();
  r.register(
    jsOnlyNode.type,
    (parameters) => jsOnlyNode.createInstance("behavior", parameters) as unknown as FXBehaviorNode,
  );
  const graph = new FXGraph<FXBehaviorNode>();
  graph.ingest({
    nodes: new Map([["lut", r.create("test-js-only-lut-sample", {})]]),
    connections: [],
    outputBindings: [bind("lifetime", "lut", "out", FXBehaviorPhase.SPAWN)],
  });
  return graph;
}

describe("compileBehaviorBundle", () => {
  it("attempts the standard family only when tryGpuSimulation is on, for a GLSL-compilable graph", () => {
    const graph = spawnBoxGraph();
    const on = compileBehaviorBundle(graph, buildParticleBehaviorTargets([], true));
    expect(on.standardProgram).toBeDefined();
    expect(on.kernel).toBeDefined();

    const off = compileBehaviorBundle(graph, buildParticleBehaviorTargets([], false));
    expect(off.standardProgram).toBeUndefined();
    expect(off.kernel).toBeDefined();
  });

  it("silently omits standardProgram (no throw) when the graph is not GLSL-portable", () => {
    const graph = jsOnlyGraph();
    const targets = buildParticleBehaviorTargets([], true);

    // The individual families keep their own, unchanged contract: JS always succeeds, standard
    // always throws for this graph - the orchestrator adds tolerance without changing either.
    expect(() => compileBehavior(graph, targets)).not.toThrow();
    expect(() => compileBehaviorStandard(graph, targets)).toThrow(/unknown function "sampleLut"/);

    const bundle = compileBehaviorBundle(graph, targets);
    expect(bundle.kernel).toBeDefined();
    expect(bundle.standardProgram).toBeUndefined();
  });
});
