import { describe, expect, it } from "vitest";

import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import { compileBehaviorBundle } from "../../src/engine/behavior/FXCompiledBehaviorBundle";
import { buildParticleBehaviorTargets } from "../../src/engine/behavior/FXParticleBehaviorTarget";
import type { FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { jsOnlyBehaviorGraph } from "../helpers/behaviorTestGraphs";
import { behaviorRegistry } from "../helpers/stdRegistry";

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

function spawnBoxGraph(): FXGraph<FXBehaviorNode> {
  const r = behaviorRegistry();
  const graph = new FXGraph<FXBehaviorNode>();
  graph.ingest({
    nodes: new Map([["box", r.create("spawn-box", { size: [2, 2, 2], center: [0, 0, 0] })]]),
    connections: [],
    outputBindings: [bind("position", "box", "position", FXBehaviorPhase.SPAWN)],
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
    // The standard family throws for this graph (behaviorKernelStandard.test.ts pins that);
    // the orchestrator tolerates the throw and keeps the JS kernel.
    const graph = jsOnlyBehaviorGraph();
    const targets = buildParticleBehaviorTargets([], true);

    const bundle = compileBehaviorBundle(graph, targets);
    expect(bundle.kernel).toBeDefined();
    expect(bundle.standardProgram).toBeUndefined();
  });
});
