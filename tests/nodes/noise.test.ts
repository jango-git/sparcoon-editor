import { describe, expect, it } from "vitest";
import type { FXConnection, FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import { registerStandardBehaviorNodes } from "../../src/engine/nodes-std/index";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import {
  buildParticleUpdateKernel,
  compileParticleBehavior,
} from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { FX_FUNCTIONS } from "../../src/engine/core/ir/FXFunctions.Internal";
import { scalarize } from "../../src/engine/core/codegen/scalarize.Internal";
import { printJS } from "../../src/engine/core/codegen/printJS.Internal";
import { printGLSLBaseline } from "../../src/engine/core/codegen/printGLSLBaseline.Internal";
import { ref } from "../../src/engine/core/ir/FXExprBuilder";
import { call } from "../helpers/exprCall";

function bind(slot: string, nodeId: string, socketKey: string): FXOutputBinding {
  return { slot, from: { nodeId, socketKey } };
}

function edge(fromNode: string, fromKey: string, toNode: string, toKey: string): FXConnection {
  return {
    from: { nodeId: fromNode, socketKey: fromKey },
    to: { nodeId: toNode, socketKey: toKey },
  };
}

function coreBuffers(): Record<string, Float32Array> {
  return { position: new Float32Array(3), lifecycle: Float32Array.from([0, 1]) };
}

function registry(): FXNodeRegistry<FXBehaviorNode> {
  const r = new FXNodeRegistry<FXBehaviorNode>();
  registerStandardBehaviorNodes(r);
  return r;
}

/**
 * constant(position vecN) -> noise(params) -> positionX; runs the update kernel (the JS
 * backend, so this exercises the scalarizer + jsHelper end-to-end) and returns the sampled scalar.
 */
function evalNoise(position: readonly number[], params: Record<string, unknown> = {}): number {
  const r = registry();
  const type = position.length === 1 ? "float" : position.length === 2 ? "vec2" : "vec3";
  const value = type === "float" ? position[0] : position;
  const nodes = new Map<string, FXBehaviorNode>([
    ["p", r.create("constant", { value, type })],
    ["n", r.create("noise", params)],
  ]);
  const graph = new FXGraph<FXBehaviorNode>();
  graph.ingest({
    nodes,
    connections: [edge("p", "out", "n", "p")],
    outputBindings: [bind("positionX", "n", "out")],
  });
  const compiled = compileParticleBehavior(graph);
  const update = buildParticleUpdateKernel(compiled);
  const buffers = coreBuffers();
  update(buffers, 1, 0.016, compiled.update.bindings);
  return buffers.position[0];
}

describe("noise node - registration & IR shape", () => {
  it("registers the noise node", () => {
    expect(registry().has("noise")).toBe(true);
  });

  it("scalarizes noise(vec2) into a single scalar fxNoise2 call", () => {
    const expr = call("noise", ref("local", "v", FX_VALUE_TYPES.vec2));
    const components = scalarize(expr);
    expect(components).toHaveLength(1);
    expect(printJS(components[0], FX_FUNCTIONS).code).toBe("fxNoise2(v_x, v_y)");
  });

  it("scalarizes noise(vec3) into a single scalar fxNoise3 call", () => {
    const expr = call("noise", ref("local", "v", FX_VALUE_TYPES.vec3));
    const components = scalarize(expr);
    expect(components).toHaveLength(1);
    expect(printJS(components[0], FX_FUNCTIONS).code).toBe("fxNoise3(v_x, v_y, v_z)");
  });

  it("prints an overloaded noise() in GLSL and pulls the shared (baseline) helper", () => {
    const printed = printGLSLBaseline(
      call("noise", ref("local", "v", FX_VALUE_TYPES.vec3)),
      FX_FUNCTIONS,
    );
    expect(printed.code).toBe("noise(v)");
    expect(printed.helpers.get("noise")).toContain("float noise(vec2 p)");
    expect(printed.helpers.get("noise")).toContain("float noise(vec3 p)");
  });

  it("scalarizes fbm3(vec3, octaves) into a single scalar fxFbm3 call with 4 flat args", () => {
    const expr = call(
      "fbm3",
      ref("local", "v", FX_VALUE_TYPES.vec3),
      ref("local", "o", FX_VALUE_TYPES.float),
    );
    const components = scalarize(expr);
    expect(components).toHaveLength(1);
    expect(printJS(components[0], FX_FUNCTIONS).code).toBe("fxFbm3(v_x, v_y, v_z, o)");
  });
});

describe("noise node - CPU (behavior) numerics", () => {
  it("is deterministic at the origin, and repeatable across calls", () => {
    // Value noise (unlike simplex) does not vanish at a lattice point - the smoothing weight is
    // 0 there, so the result collapses to the exact raw corner hash instead.
    expect(evalNoise([0, 0])).toBe(evalNoise([0, 0]));
    expect(evalNoise([0, 0, 0])).toBe(evalNoise([0, 0, 0]));
  });

  it("is deterministic for a given coordinate", () => {
    expect(evalNoise([1.3, -2.1])).toBe(evalNoise([1.3, -2.1]));
    expect(evalNoise([1.3, -2.1, 0.7])).toBe(evalNoise([1.3, -2.1, 0.7]));
  });

  it("stays within [-1, 1] for a sweep of samples", () => {
    for (let i = 0; i < 40; i++) {
      const p = i * 0.37;
      for (const value of [evalNoise([p, p * 1.7]), evalNoise([p, p * 1.7, -p * 0.9])]) {
        expect(value).toBeGreaterThanOrEqual(-1.001);
        expect(value).toBeLessThanOrEqual(1.001);
      }
    }
  });

  it("varies across space but is continuous (small step -> small change)", () => {
    const a = evalNoise([3.2, 1.1]);
    const far = evalNoise([9.8, -4.4]);
    const near = evalNoise([3.2 + 1e-3, 1.1]);
    expect(Math.abs(a - far)).toBeGreaterThan(1e-3); // genuinely varies
    expect(Math.abs(a - near)).toBeLessThan(1e-2); // but continuous
  });

  it("seed offsets the field; frequency rescales it", () => {
    expect(evalNoise([1.0, 1.0], { seed: 5 })).not.toBeCloseTo(evalNoise([1.0, 1.0]), 4);
    // frequency 0 collapses every coordinate to the origin, regardless of p or seed.
    expect(evalNoise([2.5, -1.3], { frequency: 0 })).toBeCloseTo(evalNoise([0, 0]), 5);
  });

  it("fBm octaves stay in range and differ from a single octave", () => {
    const one = evalNoise([2.1, 0.6], { octaves: "1" });
    const four = evalNoise([2.1, 0.6], { octaves: "4" });
    expect(four).not.toBeCloseTo(one, 4);
    expect(four).toBeGreaterThanOrEqual(-1.001);
    expect(four).toBeLessThanOrEqual(1.001);
  });

  it("accepts a float (1D) domain too - a coherent random walk over a single scalar", () => {
    expect(evalNoise([1.3])).toBe(evalNoise([1.3]));
    for (let i = 0; i < 40; i++) {
      const value = evalNoise([i * 0.37]);
      expect(value).toBeGreaterThanOrEqual(-1.001);
      expect(value).toBeLessThanOrEqual(1.001);
    }
    const a = evalNoise([3.2]);
    const far = evalNoise([9.8]);
    const near = evalNoise([3.2 + 1e-3]);
    expect(Math.abs(a - far)).toBeGreaterThan(1e-3);
    expect(Math.abs(a - near)).toBeLessThan(1e-2);
  });
});

/**
 * constant(position vecN) -> curl-noise -> split -> positionX/Y/Z; returns the flow vector's
 * components (length 2 for a vec2 input, 3 for a vec3 input).
 */
function evalCurl(position: readonly number[], params: Record<string, unknown> = {}): number[] {
  const r = registry();
  const type = position.length === 2 ? "vec2" : "vec3";
  const nodes = new Map<string, FXBehaviorNode>([
    ["p", r.create("constant", { value: position, type })],
    ["c", r.create("curl-noise", params)],
    ["s", r.create("split", undefined)],
  ]);
  const bindings: FXOutputBinding[] = [bind("positionX", "s", "x"), bind("positionY", "s", "y")];
  if (position.length === 3) {
    bindings.push(bind("positionZ", "s", "z"));
  }
  const graph = new FXGraph<FXBehaviorNode>();
  graph.ingest({
    nodes,
    connections: [edge("p", "out", "c", "p"), edge("c", "out", "s", "v")],
    outputBindings: bindings,
  });
  const compiled = compileParticleBehavior(graph);
  const update = buildParticleUpdateKernel(compiled);
  const buffers = coreBuffers();
  update(buffers, 1, 0.016, compiled.update.bindings);
  return position.length === 2
    ? [buffers.position[0], buffers.position[1]]
    : [buffers.position[0], buffers.position[1], buffers.position[2]];
}

describe("curl-noise node", () => {
  it("registers the curl-noise node", () => {
    expect(registry().has("curl-noise")).toBe(true);
  });

  it("outputs a vector matching the input width (vec2 -> 2, vec3 -> 3)", () => {
    expect(evalCurl([0.5, 1.5])).toHaveLength(2);
    expect(evalCurl([0.5, 1.5, -0.7])).toHaveLength(3);
  });

  it("is deterministic and finite", () => {
    const a = evalCurl([1.3, -2.1, 0.7]);
    const b = evalCurl([1.3, -2.1, 0.7]);
    expect(a).toEqual(b);
    for (const c of a) {
      expect(Number.isFinite(c)).toBe(true);
    }
  });

  it("produces a non-constant field", () => {
    const a = evalCurl([1.0, 1.0, 1.0]);
    const b = evalCurl([5.0, -3.0, 2.0]);
    expect(a).not.toEqual(b);
    // Not the trivial zero field either.
    expect(a.some((c) => Math.abs(c) > 1e-4)).toBe(true);
  });

  it("is (approximately) divergence-free - the defining property of curl", () => {
    // div = d(vx)/dx + d(vy)/dy + d(vz)/dz, via central differences of the field itself.
    const p = [2.3, -1.1, 0.9];
    const h = 0.05;
    let div = 0;
    let magnitude = 0;
    for (let ax = 0; ax < 3; ax++) {
      const plus = [...p];
      const minus = [...p];
      plus[ax] += h;
      minus[ax] -= h;
      const vPlus = evalCurl(plus);
      const vMinus = evalCurl(minus);
      div += (vPlus[ax] - vMinus[ax]) / (2 * h);
      magnitude += Math.abs(evalCurl(p)[ax]);
    }
    // Divergence should be tiny next to the field magnitude (a raw vector noise would not be).
    expect(Math.abs(div)).toBeLessThan(0.1 * (magnitude + 1));
  });

  it("fBm octaves change the field", () => {
    const one = evalCurl([2.1, 0.6, -1.4], { octaves: "1" });
    const four = evalCurl([2.1, 0.6, -1.4], { octaves: "4" });
    expect(four).not.toEqual(one);
  });
});
