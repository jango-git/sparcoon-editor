import { describe, expect, it } from "vitest";

import { printGLSLBaseline } from "../../src/engine/core/codegen/printGLSLBaseline.Internal";
import { printGLSLStandard } from "../../src/engine/core/codegen/printGLSLStandard.Internal";
import { printJS } from "../../src/engine/core/codegen/printJS.Internal";
import { scalarize } from "../../src/engine/core/codegen/scalarize.Internal";
import type { FXOutputBinding } from "../../src/engine/core/FXGraph";
import { construct, ref } from "../../src/engine/core/ir/FXExprBuilder";
import { FX_FUNCTIONS } from "../../src/engine/core/ir/FXFunctions.Internal";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { call } from "../helpers/exprCall";
import { bind, edge, graphOf, runKernel } from "../helpers/graphBuild";
import { behaviorRegistry } from "../helpers/stdRegistry";

const reg = behaviorRegistry();

/**
 * constant(position vecN) -> noise(params) -> positionX; runs the update kernel (the JS
 * backend, so this exercises the scalarizer + jsHelper end-to-end) and returns the sampled scalar.
 */
function evalNoise(position: readonly number[], params: Record<string, unknown> = {}): number {
  const type = position.length === 1 ? "float" : position.length === 2 ? "vec2" : "vec3";
  const value = type === "float" ? position[0] : position;
  const graph = graphOf(
    { p: reg.create("constant", { value, type }), n: reg.create("noise", params) },
    [edge("p", "out", "n", "p")],
    [bind("positionX", "n", "out")],
  );
  return runKernel(graph).position[0];
}

describe("noise node - IR shape", () => {
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

  it("scalarizes fbm(vec3, octaves, lacunarity, gain) into one flat fxFractal3 call", () => {
    const o = ref("local", "o", FX_VALUE_TYPES.float);
    const expr = call("fbm", ref("local", "v", FX_VALUE_TYPES.vec3), o, o, o);
    const components = scalarize(expr);
    expect(components).toHaveLength(1);
    expect(printJS(components[0], FX_FUNCTIONS).code).toBe("fxFractal3(v_x, v_y, v_z, o, o, o)");
  });

  it("scalarizes a vector-result call into one call per component, index last", () => {
    const o = ref("local", "o", FX_VALUE_TYPES.float);
    const components = scalarize(
      call("curlOctaves2", ref("local", "v", FX_VALUE_TYPES.vec2), o, o),
    );
    expect(components.map((component) => printJS(component, FX_FUNCTIONS).code)).toEqual([
      "fxCurl2(v_x, v_y, 2, o, o, 0)",
      "fxCurl2(v_x, v_y, 2, o, o, 1)",
    ]);
  });

  it("unrolls fixed-octave fBm and curl in GLSL: no loop, one sample block per octave", () => {
    const v = ref("local", "v", FX_VALUE_TYPES.vec3);
    const o = ref("local", "o", FX_VALUE_TYPES.float);
    for (const printer of [printGLSLBaseline, printGLSLStandard]) {
      const fbm = printer(call("fbmOctaves3", v, o, o), FX_FUNCTIONS);
      expect(fbm.code).toBe("fxFbmOctaves3(v, o, o)");
      const fbmSource = fbm.helpers.get("fbmOctaves3") ?? "";
      expect(fbmSource).not.toContain("for(");
      expect(
        fbmSource
          .split("\n")
          .find((line) => line.includes("vec3 p"))
          ?.match(/noise\(p\)/g),
      ).toHaveLength(3);
      const curlSource =
        printer(call("curlOctaves2", v, o, o), FX_FUNCTIONS).helpers.get("curlOctaves2") ?? "";
      expect(curlSource).not.toContain("for(");
    }
  });

  it("emits shared noise helpers once, dependencies first", () => {
    const v = ref("local", "v", FX_VALUE_TYPES.vec3);
    const o = ref("local", "o", FX_VALUE_TYPES.float);
    const printed = printGLSLStandard(
      construct(FX_VALUE_TYPES.vec2, call("noise", v), call("fbm", v, o, o, o)),
      FX_FUNCTIONS,
    );
    expect([...printed.helpers.keys()]).toEqual(["fxHash", "noise", "fbm"]);
    const js = printJS(scalarize(call("curlOctaves1", v, o, o))[0], FX_FUNCTIONS);
    expect([...js.helpers.keys()]).toEqual(["fxHash", "fxNoised", "curl"]);
  });

  it("prints voronoi variants per tier: float hashes on baseline, PCG on standard", () => {
    const v = ref("local", "v", FX_VALUE_TYPES.vec2);
    const j = ref("local", "j", FX_VALUE_TYPES.float);
    const expr = call("voronoiFastEuclidean", v, j);
    const baseline = printGLSLBaseline(expr, FX_FUNCTIONS);
    expect(baseline.code).toBe("fxVoronoiFastEuclidean(v, j)");
    expect(baseline.helpers.get("fxHash")).toContain("vec2 fxHash22(vec2 p)");
    expect(baseline.helpers.get("voronoiFastEuclidean")).toContain("fxHash22(t)");
    const standard = printGLSLStandard(expr, FX_FUNCTIONS);
    expect(standard.helpers.get("voronoiFastEuclidean")).toContain("fxUnit2(t)");
    expect(printJS(scalarize(expr)[2], FX_FUNCTIONS).code).toBe("fxVoronoi2(v_x, v_y, j, 0, 0, 2)");
  });
});

describe("noise node - CPU (behavior) numerics", () => {
  it("is deterministic for a given coordinate, lattice points included", () => {
    // At a lattice point (the origin) the smoothing weight is 0, so value noise collapses to the
    // raw corner hash - still a fixed value.
    for (const p of [
      [0, 0],
      [0, 0, 0],
      [1.3, -2.1],
      [1.3, -2.1, 0.7],
    ]) {
      expect(evalNoise(p)).toBe(evalNoise(p));
    }
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
  const type = position.length === 2 ? "vec2" : "vec3";
  const bindings: FXOutputBinding[] = [bind("positionX", "s", "x"), bind("positionY", "s", "y")];
  if (position.length === 3) {
    bindings.push(bind("positionZ", "s", "z"));
  }
  const graph = graphOf(
    {
      p: reg.create("constant", { value: position, type }),
      c: reg.create("curl-noise", params),
      s: reg.create("split"),
    },
    [edge("p", "out", "c", "p"), edge("c", "out", "s", "v")],
    bindings,
  );
  return [...runKernel(graph).position.subarray(0, position.length)];
}

describe("curl-noise node", () => {
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

  it("matches the central-difference curl of the noise potential (analytic gradients)", () => {
    const h = 1e-4;
    const derivative = (point: readonly number[], axis: number): number => {
      const plus = [...point];
      const minus = [...point];
      plus[axis] += h;
      minus[axis] -= h;
      return (evalNoise(plus) - evalNoise(minus)) / (2 * h);
    };
    const shifted = (point: readonly number[], offset: readonly number[]): number[] =>
      point.map((value, i) => value + offset[i]);

    const p2 = [1.37, -0.61];
    const [cx, cy] = evalCurl(p2);
    expect(cx).toBeCloseTo(derivative(p2, 1), 3);
    expect(cy).toBeCloseTo(-derivative(p2, 0), 3);

    const p3 = [0.73, 2.29, -1.18];
    const psi2 = shifted(p3, [31.416, 12.703, 5.906]);
    const psi3 = shifted(p3, [-43.28, 27.13, -19.87]);
    const curl = evalCurl(p3);
    expect(curl[0]).toBeCloseTo(derivative(psi3, 1) - derivative(psi2, 2), 3);
    expect(curl[1]).toBeCloseTo(derivative(p3, 2) - derivative(psi3, 0), 3);
    expect(curl[2]).toBeCloseTo(derivative(psi2, 0) - derivative(p3, 1), 3);
  });
});

/** constant(position) -> voronoi(params) -> one output into positionX, per output (JS backend). */
function evalVoronoi(
  position: readonly number[],
  params: Record<string, unknown> = {},
): { f1: number; f2: number; edge: number; cell: number } {
  const type = position.length === 2 ? "vec2" : "vec3";
  const read = (output: string): number =>
    runKernel(
      graphOf(
        { p: reg.create("constant", { value: position, type }), v: reg.create("voronoi", params) },
        [edge("p", "out", "v", "p")],
        [bind("positionX", "v", output)],
      ),
    ).position[0];
  return { f1: read("f1"), f2: read("f2"), edge: read("edge"), cell: read("cell") };
}

describe("voronoi node", () => {
  const samples = Array.from({ length: 30 }, (_, i) => [
    i * 0.731 - 7.3,
    i * 0.417 + 2.1,
    i * -0.29,
  ]);

  it("orders F1 <= F2, edge = F2 - F1 >= 0, cell in [0, 1)", () => {
    for (const metric of ["euclidean", "manhattan", "chebyshev"]) {
      for (const sample of samples) {
        for (const position of [sample.slice(0, 2), sample]) {
          const v = evalVoronoi(position, { metric });
          expect(v.f1).toBeGreaterThanOrEqual(0);
          expect(v.f2).toBeGreaterThanOrEqual(v.f1);
          expect(v.edge).toBeCloseTo(v.f2 - v.f1, 6);
          expect(v.cell).toBeGreaterThanOrEqual(0);
          expect(v.cell).toBeLessThan(1);
        }
      }
    }
  });

  it("fast quality finds the same nearest point as full for moderate jitter", () => {
    for (const sample of samples) {
      for (const position of [sample.slice(0, 2), sample]) {
        const fast = evalVoronoi(position, { quality: "fast", jitter: 0.5 });
        const full = evalVoronoi(position, { quality: "full", jitter: 0.5 });
        expect(fast.f1).toBeCloseTo(full.f1, 9);
        expect(fast.cell).toBe(full.cell);
      }
    }
  });

  it("zero jitter is the regular grid of cell centers", () => {
    const v = evalVoronoi([3.5, -1.5], { jitter: 0 });
    expect(v.f1).toBeCloseTo(0, 9);
    expect(v.f2).toBeCloseTo(1, 9);
  });
});

describe("hash node", () => {
  /** hash(params) fed `seed` (a float constant, or the particle id when omitted) -> position. */
  function evalHash(params: Record<string, unknown>, seed?: number, id = 0): number[] {
    const nodes = { h: reg.create("hash", params) };
    const graph =
      seed === undefined
        ? graphOf(nodes, [], [bind("position", "h", "out")])
        : graphOf(
            { ...nodes, s: reg.create("constant", { value: seed }) },
            [edge("s", "out", "h", "seed")],
            [bind("position", "h", "out")],
          );
    return [...runKernel(graph, { state: { lifecycle: [0, 0, id] } }).position];
  }

  it("is stable per seed, in [0, 1), and decorrelates neighbouring seeds", () => {
    const values = Array.from({ length: 200 }, (_, i) => evalHash({}, i * 1e-4)[0]);
    expect(evalHash({}, 0.0123)).toEqual(evalHash({}, 0.0123));
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    // Seeds 1e-4 apart: a smooth function would move by tiny steps, a hash jumps anywhere.
    const steps = values.slice(1).map((value, i) => Math.abs(value - (values[i] ?? 0)));
    expect(steps.reduce((sum, step) => sum + step, 0) / steps.length).toBeGreaterThan(0.2);
  });

  it("hashes the particle id when the seed is unconnected", () => {
    expect(evalHash({}, undefined, 7)).toEqual(evalHash({}, 7));
    expect(evalHash({}, undefined, 7)).not.toEqual(evalHash({}, undefined, 8));
  });

  it("gives another draw for another salt, and maps vector components into [min, max)", () => {
    expect(evalHash({ salt: 1 }, 3)[0]).not.toBe(evalHash({ salt: 0 }, 3)[0]);
    const [x, y, z] = evalHash({ type: "vec3", min: [-1, 2, 5], max: [1, 3, 5] }, 3);
    expect(x).toBeGreaterThanOrEqual(-1);
    expect(x).toBeLessThan(1);
    expect(y).toBeGreaterThanOrEqual(2);
    expect(y).toBeLessThan(3);
    expect(z).toBe(5);
    // The first component of a wider hash is the scalar hash of the same seed and salt.
    expect((x + 1) / 2).toBeCloseTo(evalHash({}, 3)[0], 6);
  });

  it("splats scalar ranges across a vector type, its defaults too", () => {
    // The default max (1) must cover every component, not pad to (1, 0, 0).
    const draws = Array.from({ length: 50 }, (_, i) => evalHash({ type: "vec3" }, i));
    expect(draws.some(([, y = 0, z = 0]) => y > 0 && z > 0)).toBe(true);
    const [x, y, z] = evalHash({ type: "vec3", min: 4, max: 4 }, 1);
    expect([x, y, z]).toEqual([4, 4, 4]);
  });

  it("prints per tier: Hoskins' float hash on baseline, PCG of the float bits on standard", () => {
    const s = ref("local", "s", FX_VALUE_TYPES.vec3);
    const salt = ref("local", "salt", FX_VALUE_TYPES.float);
    const expr = call("seedHash2", s, salt);
    const baseline = printGLSLBaseline(expr, FX_FUNCTIONS);
    expect(baseline.code).toBe("fxSeedHash2(s, salt)");
    expect(baseline.helpers.get("seedHash")).toContain("fxHash44(vec4(s,salt)).xy");
    const standard = printGLSLStandard(expr, FX_FUNCTIONS);
    expect(standard.helpers.get("seedHash")).toContain("floatBitsToUint(s)");
    expect(printJS(scalarize(expr)[1], FX_FUNCTIONS).code).toBe(
      "fxSeedHash2(s_x, s_y, s_z, salt, 1)",
    );
  });
});
