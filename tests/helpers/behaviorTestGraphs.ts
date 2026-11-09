import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { defineNode } from "../../src/engine/core/nodes/defineNode";
import { behaviorRegistry } from "./stdRegistry";

/** A one-node graph whose `out` socket feeds `slot` in `phase`. */
export function singleNodeBehaviorGraph(
  node: FXBehaviorNode,
  slot: string,
  phase: FXBehaviorPhase,
): FXGraph<FXBehaviorNode> {
  const graph = new FXGraph<FXBehaviorNode>();
  graph.ingest({
    nodes: new Map([["n", node]]),
    connections: [],
    outputBindings: [{ slot, from: { nodeId: "n", socketKey: "out" }, phase }],
  });
  return graph;
}

/**
 * Calls `sampleLut`, which is JS-only and called by no standard node - so the graph built over it
 * is valid for the JS behavior backend but not GLSL-portable.
 */
const JS_ONLY_LUT_SAMPLE = defineNode({
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

/** A spawn graph the JS behavior backend compiles and the standard (GLSL) backend rejects. */
export function jsOnlyBehaviorGraph(): FXGraph<FXBehaviorNode> {
  const node = behaviorRegistry(JS_ONLY_LUT_SAMPLE).create(JS_ONLY_LUT_SAMPLE.type, {});
  return singleNodeBehaviorGraph(node, "lifetime", FXBehaviorPhase.SPAWN);
}
