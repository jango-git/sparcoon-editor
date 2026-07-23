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

describe("printer metadata", () => {
  it("GLSL name overrides only where the builtin differs", () => {
    expect(FX_FUNCTIONS.get("sin")!.glslBaseline).toBeUndefined();
    expect(FX_FUNCTIONS.get("atan2")!.glslBaseline).toBe("atan");
    const saturate = FX_FUNCTIONS.get("saturate")!.glslBaseline as (
      args: readonly string[],
    ) => string;
    expect(saturate(["v"])).toBe("clamp(v, 0.0, 1.0)");
  });

  it("round overrides GLSL to floor(x + 0.5) but keeps Math.round in JS (N2)", () => {
    const round = FX_FUNCTIONS.get("round")!;
    const glslBaseline = round.glslBaseline as (args: readonly string[]) => string;
    expect(glslBaseline(["x"])).toBe("floor(x + 0.5)");
    expect(round.js(["x"])).toBe("Math.round(x)");
  });

  it("scalar JS printers emit the expected code", () => {
    expect(FX_FUNCTIONS.get("sin")!.js(["a"])).toBe("Math.sin(a)");
    expect(FX_FUNCTIONS.get("fract")!.js(["a"])).toBe("fxFract(a)");
    expect(FX_FUNCTIONS.get("step")!.js(["e", "x"])).toBe("(x < e ? 0.0 : 1.0)");
    expect(FX_FUNCTIONS.get("saturate")!.js(["a"])).toBe("Math.min(Math.max(a, 0.0), 1.0)");
    expect(FX_FUNCTIONS.get("mix")!.js(["a", "b", "t"])).toBe("fxMix(a, b, t)");
  });

  it("helper-backed functions carry their helper source", () => {
    for (const name of ["fract", "mod", "mix", "smoothstep"]) {
      expect(FX_FUNCTIONS.get(name)!.jsHelper, name).toBeTruthy();
    }
    expect(FX_FUNCTIONS.get("sin")!.jsHelper).toBeUndefined();
  });

  it("vector reductions throw if their scalar JS is ever reached", () => {
    for (const name of ["length", "dot", "normalize"]) {
      expect(() => FX_FUNCTIONS.get(name)!.js(["v"]), name).toThrow(/no scalar JS form/);
    }
  });
});
