import { describe, expect, it } from "vitest";

import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import { compileBehavior } from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import { compileBehaviorStandard } from "../../src/engine/behavior/FXParticleBehaviorKernelStandard.Internal";
import {
  buildParticleBehaviorTargets,
  FX_PARTICLE_INDEX_INPUT,
} from "../../src/engine/behavior/FXParticleBehaviorTarget";
import type { FXConnection } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { defineNode } from "../../src/engine/core/nodes/defineNode";
import { jsOnlyBehaviorGraph, singleNodeBehaviorGraph } from "../helpers/behaviorTestGraphs";
import { behaviorRegistry } from "../helpers/stdRegistry";

// The standard-tier (GLSL) behavior pipeline is a sibling of the JS one (FXParticleBehaviorKernel.
// Internal.ts) with no scalarize/CSE pass - GLSL handles vectors natively. These are smoke tests
// over the compiled GLSL text/writes, the same style as tests/core/cseKernel.test.ts, since a real
// GLSL compiler is not available in this headless container.

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
    outputBindings: [
      { slot: "position", from: { nodeId: terminal, socketKey }, phase: FXBehaviorPhase.SPAWN },
    ],
  });
  return compileBehaviorStandard(graph, buildParticleBehaviorTargets());
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("standard-tier behavior kernel", () => {
  it("compiles a spawn-box into GLSL writing three independent fxNextRandom() draws", () => {
    const r = behaviorRegistry();
    const compiled = spawnPhase(
      new Map([["box", r.create("spawn-box", { size: [2, 2, 2], center: [0, 0, 0] })]]),
      [],
      "box",
      "position",
    );
    const body = compiled.spawn!.body.join("\n");
    // No CSE on this backend - three real draws, three real calls, no dedup risk to guard.
    expect(occurrences(body, "fxNextRandom()")).toBe(3);
    // The rand helper (keyed "rand") must be present exactly once regardless of call count.
    expect(compiled.spawn!.helpers.filter((h) => h.includes("fxNextRandom")).length).toBe(1);
    // Writes land on the position buffer at the vec3 offsets, one write per component.
    const positionWrites = compiled.spawn!.writes.filter((w) => w.buffer === "position");
    expect(positionWrites.map((w) => w.offset).sort()).toEqual([0, 1, 2]);
  });

  it("resolves dt to the synthesized uniform, not the bare JS identifier", () => {
    const graph = singleNodeBehaviorGraph(
      behaviorRegistry().create("delta-time", {}),
      "position",
      FXBehaviorPhase.UPDATE,
    );
    const compiled = compileBehaviorStandard(graph, buildParticleBehaviorTargets());
    // The synthesized dt/emitter-transform uniforms are always declared by the assembler,
    // regardless of whether a given graph reads them - the compile step here only needs to
    // reference the right, stable name, not declare it itself.
    expect(compiled.update.body.join("\n")).toContain("u_fxDt");
  });

  it("resolves PARTICLE_INDEX to gl_VertexID", () => {
    const particleIndex = defineNode({
      type: "test-particle-index",
      domain: "behavior",
      phase: "spawn",
      category: "source",
      inputs: {},
      outputs: { out: { type: "float" } },
      params: {},
      cost: 0,
      reads: [FX_PARTICLE_INDEX_INPUT],
      build: ({ fn, target }) => ({ out: fn.toFloat(target.read(FX_PARTICLE_INDEX_INPUT)) }),
    });
    const graph = singleNodeBehaviorGraph(
      behaviorRegistry(particleIndex).create(particleIndex.type, {}),
      "lifetime",
      FXBehaviorPhase.SPAWN,
    );
    const body = compileBehaviorStandard(graph, buildParticleBehaviorTargets()).spawn!.body;
    expect(body.join("\n")).toContain("gl_VertexID");
  });

  it("resolves PARTICLE_AGE to a swizzle of the native lifecycle attribute", () => {
    const graph = singleNodeBehaviorGraph(
      behaviorRegistry().create("read-state", { builtin: "PARTICLE_AGE" }),
      "lifetime",
      FXBehaviorPhase.SPAWN,
    );
    const compiled = compileBehaviorStandard(graph, buildParticleBehaviorTargets());
    // PARTICLE_AGE (offset 0 of the 2-wide lifecycle buffer) swizzles off the native attribute.
    expect(compiled.spawn!.body.join("\n")).toContain("in_lifecycle.x");
  });

  it("throws a clean, catchable build-time error for a JS-only function - never broken GLSL", () => {
    // The per-emitter GPU fallback relies on this compile step throwing cleanly rather than
    // failing later at shader link time.
    const graph = jsOnlyBehaviorGraph();
    // The JS backend has no trouble with it at all - confirms the fixture is otherwise valid
    // and the GLSL failure below is specifically about portability, not a malformed graph.
    expect(() => compileBehavior(graph, buildParticleBehaviorTargets())).not.toThrow();
    expect(() => compileBehaviorStandard(graph, buildParticleBehaviorTargets())).toThrow(
      /unknown function "sampleLut"/,
    );
  });
});
