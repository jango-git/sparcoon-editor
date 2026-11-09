import { describe, expect, it } from "vitest";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { FX_FUNCTIONS } from "../../src/engine/core/ir/FXFunctions.Internal";
import { lit, litVec } from "../../src/engine/core/ir/FXExprBuilder";
import { call } from "../helpers/exprCall";

const REQUIRED = [
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "exp",
  "log",
  "sqrt",
  "abs",
  "floor",
  "ceil",
  "round",
  "fract",
  "sign",
  "min",
  "max",
  "pow",
  "mod",
  "step",
  "atan2",
  "clamp",
  "mix",
  "smoothstep",
  "length",
  "dot",
  "normalize",
  "saturate",
  "oneMinus",
];

describe("FX_FUNCTIONS registry", () => {
  it("registers the whole required set with non-empty signatures", () => {
    for (const name of REQUIRED) {
      const def = FX_FUNCTIONS.get(name);
      expect(def, name).toBeDefined();
      expect(def!.signatures.length).toBeGreaterThan(0);
    }
  });

  it("does not register render-only functions", () => {
    expect(FX_FUNCTIONS.has("texSample")).toBe(false);
  });
});

describe("call resolves against the registered signatures", () => {
  it("element-wise unary is generic over float/vecN", () => {
    expect(call("sin", lit(1)).type).toBe(FX_VALUE_TYPES.float);
    expect(call("sin", litVec(1, 2, 3)).type).toBe(FX_VALUE_TYPES.vec3);
  });

  it("splat overloads resolve", () => {
    expect(call("min", litVec(1, 2, 3), lit(0)).type).toBe(FX_VALUE_TYPES.vec3);
    expect(call("clamp", litVec(1, 2), lit(0), lit(1)).type).toBe(FX_VALUE_TYPES.vec2);
    expect(call("mix", litVec(1, 2, 3), litVec(4, 5, 6), lit(0.5)).type).toBe(FX_VALUE_TYPES.vec3);
    expect(call("step", lit(0.5), litVec(1, 2, 3, 4)).type).toBe(FX_VALUE_TYPES.vec4);
  });

  it("vector reductions return float / preserve type", () => {
    expect(call("length", litVec(1, 2, 3)).type).toBe(FX_VALUE_TYPES.float);
    expect(call("dot", litVec(1, 2), litVec(3, 4)).type).toBe(FX_VALUE_TYPES.float);
    expect(call("normalize", litVec(1, 2, 3)).type).toBe(FX_VALUE_TYPES.vec3);
  });

  it("atan2 is float-only", () => {
    expect(call("atan2", lit(1), lit(2)).type).toBe(FX_VALUE_TYPES.float);
    expect(() => call("atan2", litVec(1, 2), litVec(3, 4))).toThrow(/no signature/);
  });
});

/** Evaluates a function's scalar JS form (plus its helper, when it has one) on numeric args. */
function evalJS(name: string, ...args: number[]): number {
  const def = FX_FUNCTIONS.get(name)!;
  const params = args.map((_, index) => `a${index}`);
  const body = `${def.jsHelper ?? ""}\nreturn ${def.js(params)};`;
  return (new Function(...params, body) as (...values: number[]) => number)(...args);
}

describe("scalar JS forms", () => {
  it("step matches GLSL: 1 at the edge, 0 below it", () => {
    expect(evalJS("step", 0.5, 0.5)).toBe(1);
    expect(evalJS("step", 0.5, 0.49)).toBe(0);
  });

  it("fract and mod match GLSL: floor toward negative infinity", () => {
    expect(evalJS("fract", -0.25)).toBeCloseTo(0.75);
    expect(evalJS("mod", -1, 3)).toBe(2);
  });

  it("saturate, mix and smoothstep match their GLSL definitions", () => {
    expect(evalJS("saturate", -2)).toBe(0);
    expect(evalJS("saturate", 3)).toBe(1);
    expect(evalJS("mix", 2, 6, 0.25)).toBe(3);
    expect(evalJS("smoothstep", 0, 1, 0.5)).toBe(0.5);
    expect(evalJS("smoothstep", 0, 1, 2)).toBe(1);
  });

  it("round keeps Math.round in JS (half rounds up, as GLSL's floor(x + 0.5))", () => {
    expect(evalJS("round", 2.5)).toBe(3);
    expect(evalJS("round", -2.5)).toBe(-2);
  });

  it("vector reductions throw if their scalar JS is ever reached", () => {
    for (const name of ["length", "dot", "normalize"]) {
      expect(() => FX_FUNCTIONS.get(name)!.js(["v"]), name).toThrow(/no scalar JS form/);
    }
  });
});
