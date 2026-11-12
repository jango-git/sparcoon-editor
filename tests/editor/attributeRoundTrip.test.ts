import { describe, expect, it } from "vitest";

import { createEmptyGraph } from "../../src/domain/graphModel";
import { GraphKind } from "../../src/domain/nodePalette";
import { serializeGraph } from "../../src/domain/serialize";
import { ensureSinks } from "../../src/domain/sinks";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { compileParticleBehavior } from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import { registerManualBehaviorNodes } from "../../src/engine/behavior/nodes/FXManualBehaviorNodes";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXGraphReconciler } from "../../src/engine/core/live/FXGraphReconciler";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import { registerStandardBehaviorNodes } from "../../src/engine/nodes-std/index";

/**
 * End-to-end: an editor attribute write (a wire into a behavior sink's `attr:<name>` slot)
 * serializes, reconciles into a live graph, and compiles - allocating the buffer. This
 * proves the serialize-time materialization into a `store-attribute` node is a valid
 * engine snapshot, closing the loop the editor UI will drive once wiring exists.
 */
describe("attribute write round-trip", () => {
  it("serialized attr:<name> binding compiles and allocates the buffer", () => {
    const editorGraph = ensureSinks(
      {
        ...createEmptyGraph(),
        nodes: { rnd: { id: "rnd", type: "random", parameters: {}, position: { x: 0, y: 0 } } },
        attributes: [{ name: "seed", type: "float" }],
        outputBindings: [
          { slot: "attr:seed", from: { nodeId: "rnd", socketKey: "out" }, phase: "spawn" },
        ],
      },
      GraphKind.Behavior,
    );

    const snapshot = serializeGraph(editorGraph);

    const registry = new FXNodeRegistry<FXBehaviorNode>();
    registerStandardBehaviorNodes(registry);
    registerManualBehaviorNodes(registry);
    const graph = new FXGraph<FXBehaviorNode>();
    const result = new FXGraphReconciler(registry).reconcile(graph, snapshot);
    expect(result.errors).toEqual([]);

    const compiled = compileParticleBehavior(graph);
    expect(compiled.spawn).toBeDefined();
    // The `seed` attribute buffer is allocated because the materialized store-attribute
    // node carries its attributeRequest and is reachable from the output binding.
    expect(compiled.update.buffers.some((buffer) => buffer.name === "seed")).toBe(true);
  });
});
