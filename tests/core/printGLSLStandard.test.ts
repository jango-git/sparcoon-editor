import { describe, expect, it } from "vitest";
import { isFXCompilerErrorException } from "../../src/engine/core/compiler/FXCompilerError";
import type { FXExpr } from "../../src/engine/core/ir/FXExpr";
import type { FXFunctionDef } from "../../src/engine/core/ir/FXFunctions.Internal";
import { FX_FUNCTIONS } from "../../src/engine/core/ir/FXFunctions.Internal";
import {
  glslFloat,
  glslInt,
  printGLSLStandard,
} from "../../src/engine/core/codegen/printGLSLStandard.Internal";
import {
  column,
  construct,
  ge,
  lit,
  litInt,
  litVec,
  neg,
  raw,
  ref,
  select,
  sub,
  swizzle,
} from "../../src/engine/core/ir/FXExprBuilder";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { call } from "../helpers/exprCall";

function glsl(expr: FXExpr): string {
  return printGLSLStandard(expr, FX_FUNCTIONS).code;
}

function callOf(fn: string, ...args: FXExpr[]): FXExpr {
  return { kind: "call", type: FX_VALUE_TYPES.float, fn, args };
}

describe("literals and refs", () => {
  it("prints float literals with a decimal point and int literals without one", () => {
    expect(glsl(lit(2))).toBe("2.0");
    expect(glsl(litInt(2))).toBe("2");
    expect(glsl(litVec(1, 2.5))).toBe("vec2(1.0, 2.5)");
  });

  it("prints refs by name, or through a custom resolver", () => {
    const age = ref("targetInput", "PARTICLE_AGE", FX_VALUE_TYPES.float);
    expect(glsl(age)).toBe("PARTICLE_AGE");
    expect(printGLSLStandard(age, FX_FUNCTIONS, (candidate) => `in_${candidate.name}`).code).toBe(
      "in_PARTICLE_AGE",
    );
  });
});

describe("operators and structure", () => {
  const a = ref("local", "a", FX_VALUE_TYPES.float);
  const b = ref("local", "b", FX_VALUE_TYPES.float);
  const v = ref("local", "v", FX_VALUE_TYPES.vec4);

  it("parenthesizes arithmetic and prints comparisons as a 0/1 ternary", () => {
    expect(glsl(sub(a, b))).toBe("(a - b)");
    expect(glsl(ge(a, b))).toBe("(a >= b ? 1.0 : 0.0)");
  });

  it("keeps a space after unary minus so a negative literal never prints `--`", () => {
    expect(glsl(neg(lit(-1)))).toBe("(- -1.0)");
  });

  it("prints swizzle, construct, matrix column and select", () => {
    const m = ref("uniform", "m", FX_VALUE_TYPES.mat3);
    expect(glsl(swizzle(v, "zx"))).toBe("(v).zx");
    expect(glsl(construct(FX_VALUE_TYPES.vec3, lit(1), swizzle(v, "yz")))).toBe(
      "vec3(1.0, (v).yz)",
    );
    expect(glsl(column(m, 2))).toBe("(m)[2]");
    expect(glsl(select(ge(a, b), a, b))).toBe("((a >= b ? 1.0 : 0.0) != 0.0 ? a : b)");
  });

  it("substitutes raw GLSL deps and rejects JS or an out-of-range dep", () => {
    expect(glsl(raw(FX_VALUE_TYPES.float, "glsl", "max($1, $0)", lit(1), lit(2)))).toBe(
      "max(2.0, 1.0)",
    );
    expect(() => glsl(raw(FX_VALUE_TYPES.float, "js", "x"))).toThrow(/not printable as GLSL/);
    expect(() => glsl(raw(FX_VALUE_TYPES.float, "glsl", "$1", lit(1)))).toThrow(
      /references \$1 but has 1 deps/,
    );
  });
});

describe("calls", () => {
  const x = ref("local", "x", FX_VALUE_TYPES.float);

  it("prefers glslStandard and its helper over the baseline spelling", () => {
    const functions = new Map<string, FXFunctionDef>([
      [
        "f",
        {
          name: "f",
          signatures: [{ args: ["float"], result: "float" }],
          glslBaseline: "fBaseline",
          glslBaselineHelper: "float fBaseline(float v) { return v; }",
          glslStandard: (args) => `fStandard(${args.join(", ")})`,
          glslStandardHelper: "float fStandard(float v) { return v; }",
          js: () => "0",
        },
      ],
    ]);
    const result = printGLSLStandard(callOf("f", x), functions);
    expect(result.code).toBe("fStandard(x)");
    expect([...result.helpers]).toEqual([["f", "float fStandard(float v) { return v; }"]]);
  });

  it("falls back to the baseline spelling and helper when no standard form exists", () => {
    expect(glsl(call("atan2", lit(1), lit(2)))).toBe("atan(1.0, 2.0)");
    expect(glsl(call("saturate", x))).toBe("clamp(x, 0.0, 1.0)");
    const functions = new Map<string, FXFunctionDef>([
      [
        "g",
        {
          name: "g",
          signatures: [{ args: ["float"], result: "float" }],
          glslBaselineHelper: "float g(float v) { return v; }",
          js: () => "0",
        },
      ],
    ]);
    const result = printGLSLStandard(callOf("g", x), functions);
    expect(result.code).toBe("g(x)");
    expect(result.helpers.get("g")).toBe("float g(float v) { return v; }");
  });

  it("prints standard-only functions with their standard helpers", () => {
    const rand = printGLSLStandard(callOf("rand"), FX_FUNCTIONS);
    expect(rand.code).toBe("fxNextRandom()");
    expect(rand.helpers.get("rand")).toBe(FX_FUNCTIONS.get("rand")?.glslStandardHelper);

    const noise = printGLSLStandard(call("noise", x), FX_FUNCTIONS);
    expect(noise.helpers.get("noise")).toBe(FX_FUNCTIONS.get("noise")?.glslStandardHelper);
    expect(noise.helpers.get("noise")).not.toBe(FX_FUNCTIONS.get("noise")?.glslBaselineHelper);
  });

  it("collects each function's helper once however often it is called", () => {
    const result = printGLSLStandard(
      construct(FX_VALUE_TYPES.vec2, callOf("rand"), callOf("rand")),
      FX_FUNCTIONS,
    );
    expect(result.code).toBe("vec2(fxNextRandom(), fxNextRandom())");
    expect([...result.helpers.keys()]).toEqual(["rand"]);
  });

  it("throws on an unknown function", () => {
    expect(() => glsl(callOf("nope"))).toThrow(/unknown function "nope"/);
  });
});

describe("glslFloat / glslInt", () => {
  function codeOf(print: () => string): string | undefined {
    try {
      print();
    } catch (error) {
      return isFXCompilerErrorException(error) ? error.error.code : "untyped";
    }
    return undefined;
  }

  it("prints floats with a decimal point, exponent forms as they are", () => {
    expect(glslFloat(3)).toBe("3.0");
    expect(glslFloat(0.25)).toBe("0.25");
    expect(glslFloat(1e21)).toBe("1e+21");
  });

  it("throws a typed error for non-finite floats and non-integer ints", () => {
    expect(codeOf(() => glslFloat(Number.NaN))).toBe("glsl-float-not-finite");
    expect(codeOf(() => glslFloat(Number.POSITIVE_INFINITY))).toBe("glsl-float-not-finite");
    expect(glslInt(-4)).toBe("-4");
    expect(codeOf(() => glslInt(1.5))).toBe("glsl-int-not-finite");
    expect(codeOf(() => glslInt(Number.NaN))).toBe("glsl-int-not-finite");
  });
});
