import { describe, expect, it } from "vitest";
import { FXLiveGraph } from "../../src/engine/core/live/FXLiveGraph";
import { FXGraphReconciler } from "../../src/engine/core/live/FXGraphReconciler";
import { FXBehaviorLiveBackend } from "../../src/engine/behavior/live/FXBehaviorLiveBackend";
import { buildParticleBehaviorTargets } from "../../src/engine/behavior/FXParticleBehaviorTarget";
import type { FXCompiledBehaviorBundle } from "../../src/engine/behavior/FXCompiledBehaviorBundle";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import { registerStandardBehaviorNodes } from "../../src/engine/nodes-std/index";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import type { FXGraphSnapshotData } from "../../src/engine/core/live/FXSnapshotData";

// The "standard" (GLSL/transform-feedback) simulation family must go through the same
// recompile-vs-rebind gate the JS kernel already does, instead of re-running on every unrelated
// structural trigger. That gate lives entirely in FXLiveGraph/FXBehaviorLiveBackend, one layer
// below EmitterView (whose own public status is deliberately coarsened to "recompiled" on
// castShadow/renderMode/etc. - see emitterView.ts's `renderStructural`/`behaviorStructural` split),
// so the direct, unambiguous proof belongs here, not at the EmitterView/SceneEmitters level.

function behaviorLive(): FXLiveGraph<FXBehaviorNode, FXCompiledBehaviorBundle> {
  const registry = new FXNodeRegistry<FXBehaviorNode>();
  registerStandardBehaviorNodes(registry);
  return new FXLiveGraph(
    new FXGraphReconciler(registry),
    // "Try GPU simulation" held on for every apply - the flag itself never flips across the two
    // applies below, matching the bug's actual shape (an *unrelated* trigger, not the flag).
    new FXBehaviorLiveBackend(
      () => {},
      (attributes) => buildParticleBehaviorTargets(attributes, true),
    ),
  );
}

// A GLSL-compilable spawn graph (spawn-box), so the standard family actually produces a program -
// same fixture shape as behaviorKernelStandard.test.ts's own spawn-box smoke test.
const SPAWN_BOX: FXGraphSnapshotData = {
  version: 2,
  nodes: {
    box: { type: "spawn-box", params: { size: [2, 2, 2], center: [0, 0, 0] } },
  },
  connections: [],
  outputBindings: [{ slot: "position", from: { nodeId: "box", socketKey: "position" } }],
};

describe("FXBehaviorLiveBackend + FXLiveGraph: the standard family is cached, not rebuilt per apply", () => {
  it("compiles the standard program on the first apply, then reuses it verbatim on an identical re-apply", () => {
    const live = behaviorLive();

    const first = live.apply(SPAWN_BOX);
    expect(first.status).toBe("recompiled");
    const bundle = live.artifact;
    expect(bundle?.standardProgram).toBeDefined();

    // An identical re-apply - nothing about the graph or the flag changed. EmitterView.
    // compileGpuKernel() has no gate of its own; FXLiveGraph's hash gate must catch this
    // at the source instead.
    const second = live.apply(SPAWN_BOX);
    expect(second.status).toBe("rebound");
    // Same bundle object, same standardProgram object - proof compileBehaviorBundle (and so
    // compileBehaviorStandard) was not invoked a second time, not just that the output matches.
    expect(live.artifact).toBe(bundle);
    expect(live.artifact?.standardProgram).toBe(bundle?.standardProgram);

    live.destroy();
  });
});
