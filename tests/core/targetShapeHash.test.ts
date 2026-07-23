import { describe, expect, it } from "vitest";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { previewBehaviorHash } from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import type {
  FXBehaviorTargets,
  FXKernelTarget,
} from "../../src/engine/behavior/FXParticleBehaviorTarget";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FXShaderStage } from "../../src/engine/render/FXShaderStage";
import type { FXTarget } from "../../src/engine/render/target/FXTarget";
import type { FXValueType } from "../../src/engine/core/socket/FXValueType";
import { behaviorRegistry, renderRegistry } from "../helpers/stdRegistry";

const FLOAT = FX_VALUE_TYPES.float;
const VEC3 = FX_VALUE_TYPES.vec3;
const VEC4 = FX_VALUE_TYPES.vec4;
const { VERTEX, FRAGMENT } = FXShaderStage;

function renderGraph(): FXGraph<FXRenderNode> {
  const reg = renderRegistry();
  const graph = new FXGraph<FXRenderNode>();
  graph.ingest({
    nodes: new Map([["c", reg.create("constant", { type: "color", value: [1, 1, 1, 1] })]]),
    connections: [],
    outputBindings: [{ slot: "albedo", from: { nodeId: "c", socketKey: "out" } }],
  });
  return graph;
}

const renderTarget = (inputType: FXValueType): FXTarget => ({
  name: "shared-name",
  inputs: [{ name: "PARTICLE_AGE", type: inputType, stages: [VERTEX, FRAGMENT] }],
  outputs: [{ slot: "albedo", type: VEC4, stage: FRAGMENT, required: true }],
});

function behaviorGraph(): FXGraph<FXBehaviorNode> {
  const reg = behaviorRegistry();
  const graph = new FXGraph<FXBehaviorNode>();
  graph.ingest({
    nodes: new Map([["p", reg.create("constant", { type: "float", value: 1, phase: "update" })]]),
    connections: [],
    outputBindings: [{ slot: "v", from: { nodeId: "p", socketKey: "out" } }],
  });
  return graph;
}

const kernelTarget = (offset: number): FXBehaviorTargets => ({
  update: {
    name: "shared-name",
    buffers: [{ name: "values", stride: 2 }],
    inputs: [{ name: "dt", type: FLOAT }],
    outputs: [{ slot: "v", type: FLOAT, required: false, buffer: "values", offsets: [offset] }],
  },
});

describe("structural hash folds the target shape, not just its name", () => {
  it("render: same target name, different input type -> different hash", () => {
    const compiler = new FXCompilerBaseline();
    const graph = renderGraph();
    const a = compiler.previewHash(graph, renderTarget(FLOAT));
    const b = compiler.previewHash(graph, renderTarget(VEC3));
    expect(a).not.toBe(b);
    // Identical shape re-hashes the same (rebind still works).
    expect(compiler.previewHash(graph, renderTarget(FLOAT))).toBe(a);
  });

  it("behavior: same target name, different slot offset -> different hash", () => {
    const graph = behaviorGraph();
    const a = previewBehaviorHash(graph, kernelTarget(0));
    const b = previewBehaviorHash(graph, kernelTarget(1));
    expect(a).not.toBe(b);
    expect(previewBehaviorHash(graph, kernelTarget(0))).toBe(a);
  });

  it("behavior: same shape, different preamble -> different hash (P11.3)", () => {
    const graph = behaviorGraph();
    const withPreamble = (preamble?: readonly string[]): FXBehaviorTargets => {
      const base = kernelTarget(0).update;
      return { update: preamble === undefined ? base : { ...base, preamble } };
    };
    const a = previewBehaviorHash(graph, withPreamble(undefined));
    const b = previewBehaviorHash(graph, withPreamble(["const half = dt * 0.5;"]));
    expect(a).not.toBe(b);
    // Preamble order matters (lines splice verbatim into the loop) - folded as-is.
    const c = previewBehaviorHash(graph, withPreamble(["l1;", "l2;"]));
    const d = previewBehaviorHash(graph, withPreamble(["l2;", "l1;"]));
    expect(c).not.toBe(d);
    expect(previewBehaviorHash(graph, withPreamble(undefined))).toBe(a);
  });

  it("behavior: a '|' in phase target names does not alias distinct pairs", () => {
    const graph = behaviorGraph();
    const shell = (name: string): FXKernelTarget => ({
      name,
      buffers: [{ name: "values", stride: 2 }],
      inputs: [{ name: "dt", type: FLOAT }],
      outputs: [{ slot: "v", type: FLOAT, required: false, buffer: "values", offsets: [0] }],
    });
    // Old name-join "spawn|update" would collapse both pairs to "a|b|c".
    const x: FXBehaviorTargets = { spawn: shell("a|b"), update: shell("c") };
    const y: FXBehaviorTargets = { spawn: shell("a"), update: shell("b|c") };
    expect(previewBehaviorHash(graph, x)).not.toBe(previewBehaviorHash(graph, y));
  });

  it("behavior: same shape, different tryGpuSimulation -> different hash", () => {
    const graph = behaviorGraph();
    const withFlag = (tryGpuSimulation?: boolean): FXBehaviorTargets => ({
      ...kernelTarget(0),
      tryGpuSimulation,
    });
    const off = previewBehaviorHash(graph, withFlag(false));
    const on = previewBehaviorHash(graph, withFlag(true));
    expect(on).not.toBe(off);
    // Omitted and explicit false must hash identically - both mean "no optional family attempted".
    expect(previewBehaviorHash(graph, withFlag(undefined))).toBe(off);
    // Same flag value twice re-hashes the same (rebind still works).
    expect(previewBehaviorHash(graph, withFlag(true))).toBe(on);
  });
});
