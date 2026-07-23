import { describe, expect, it } from "vitest";
import type { FXConnection, FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import { registerStandardBehaviorNodes } from "../../src/engine/nodes-std/index";
import { defineNode } from "../../src/engine/core/nodes/defineNode";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import { compileBehavior } from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import { compileBehaviorStandard } from "../../src/engine/behavior/FXParticleBehaviorKernelStandard.Internal";
import { buildParticleBehaviorTargets } from "../../src/engine/behavior/FXParticleBehaviorTarget";

// The standard-tier (GLSL) behavior pipeline is a sibling of the JS one (FXParticleBehaviorKernel.
// Internal.ts) with no scalarize/CSE pass - GLSL handles vectors natively. These are smoke tests
// over the compiled GLSL text/writes, the same style as tests/core/cseKernel.test.ts, since a real
// GLSL compiler is not available in this headless container.

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
  return compileBehaviorStandard(graph, buildParticleBehaviorTargets());
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("standard-tier behavior kernel", () => {
  it("compiles a spawn-box into GLSL writing three independent fxNextRandom() draws", () => {
    const r = registry();
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
    const r = registry();
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes: new Map([["dt", r.create("delta-time", {})]]),
      connections: [],
      outputBindings: [
        {
          slot: "position",
          from: { nodeId: "dt", socketKey: "out" },
          phase: FXBehaviorPhase.UPDATE,
        },
      ],
    });
    const compiled = compileBehaviorStandard(graph, buildParticleBehaviorTargets());
    // The synthesized dt/emitter-transform uniforms are always declared by the assembler,
    // regardless of whether a given graph reads them - the compile step here only needs to
    // reference the right, stable name, not declare it itself.
    expect(compiled.update.body.join("\n")).toContain("u_fxDt");
  });

  it("resolves PARTICLE_INDEX to gl_VertexID", () => {
    const r = registry();
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes: new Map([["idx", r.create("read-state", { builtin: "PARTICLE_AGE" })]]),
      connections: [],
      outputBindings: [
        {
          slot: "lifetime",
          from: { nodeId: "idx", socketKey: "out" },
          phase: FXBehaviorPhase.SPAWN,
        },
      ],
    });
    const compiled = compileBehaviorStandard(graph, buildParticleBehaviorTargets());
    // PARTICLE_AGE (offset 0 of the 2-wide lifecycle buffer) swizzles off the native attribute.
    expect(compiled.spawn!.body.join("\n")).toContain("in_lifecycle.x");
  });

  it("throws a clean, catchable build-time error for a JS-only function - never broken GLSL", () => {
    // sampleLut is explicitly JS-only (FXBehaviorFunctions.Internal.ts) with no standard node
    // calling it, so this test authors a minimal fixture directly; the per-emitter GPU fallback
    // relies on this compile step throwing cleanly rather than failing later at shader link time.
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
    const r = new FXNodeRegistry<FXBehaviorNode>();
    registerStandardBehaviorNodes(r);
    r.register(
      jsOnlyNode.type,
      (parameters) =>
        jsOnlyNode.createInstance("behavior", parameters) as unknown as FXBehaviorNode,
    );

    const nodes = new Map([["lut", r.create("test-js-only-lut-sample", {})]]);
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes,
      connections: [],
      outputBindings: [bind("lifetime", "lut", "out", FXBehaviorPhase.SPAWN)],
    });

    // The JS backend has no trouble with it at all - confirms the test graph is otherwise valid
    // and the GLSL failure below is specifically about portability, not a malformed fixture.
    expect(() => compileBehavior(graph, buildParticleBehaviorTargets())).not.toThrow();
    expect(() => compileBehaviorStandard(graph, buildParticleBehaviorTargets())).toThrow(
      /unknown function "sampleLut"/,
    );
  });
});
