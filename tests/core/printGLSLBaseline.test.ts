import { describe, expect, it } from "vitest";
import { isFXCompilerErrorException } from "../../src/engine/core/compiler/FXCompilerError";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import type { FXFunctionDef } from "../../src/engine/core/ir/FXFunctions.Internal";
import { FX_FUNCTIONS } from "../../src/engine/core/ir/FXFunctions.Internal";
import {
  glslFloat,
  printGLSLBaseline,
} from "../../src/engine/core/codegen/printGLSLBaseline.Internal";
import {
  add,
  construct,
  lit,
  litVec,
  lt,
  mod,
  neg,
  raw,
  ref,
  select,
  swizzle,
} from "../../src/engine/core/ir/FXExprBuilder";
import { call } from "../helpers/exprCall";

function glsl(expr: Parameters<typeof printGLSLBaseline>[0]): string {
  return printGLSLBaseline(expr, FX_FUNCTIONS).code;
}

describe("literals and refs", () => {
  it("floats always carry a decimal point", () => {
    expect(glsl(lit(1))).toBe("1.0");
    expect(glsl(lit(0.5))).toBe("0.5");
    expect(glsl(lit(-2))).toBe("-2.0");
  });

  it("vectors print as constructors", () => {
    expect(glsl(litVec(1, 2, 3))).toBe("vec3(1.0, 2.0, 3.0)");
  });

  it("refs print by name", () => {
    expect(glsl(ref("uniform", "p_tint", FX_VALUE_TYPES.vec4))).toBe("p_tint");
  });
});

describe("operators", () => {
  const a = ref("local", "a", FX_VALUE_TYPES.float);
  const b = ref("local", "b", FX_VALUE_TYPES.float);

  it("arithmetic is parenthesized infix", () => {
    expect(glsl(add(a, b))).toBe("(a + b)");
  });

  it("neg wraps", () => {
    expect(glsl(neg(a))).toBe("(- a)");
  });

  it("neg of a negative literal keeps a space (no `--`)", () => {
    expect(glsl(neg(lit(-1)))).toBe("(- -1.0)");
  });

  it("mod prints as a call", () => {
    expect(glsl(mod(a, b))).toBe("mod(a, b)");
  });

  it("comparisons print as a 0/1 ternary", () => {
    expect(glsl(lt(a, b))).toBe("(a < b ? 1.0 : 0.0)");
  });

  it("select is a bool-coerced ternary", () => {
    const va = ref("local", "va", FX_VALUE_TYPES.vec3);
    const vb = ref("local", "vb", FX_VALUE_TYPES.vec3);
    expect(glsl(select(lt(a, b), va, vb))).toBe("((a < b ? 1.0 : 0.0) != 0.0 ? va : vb)");
  });
});

describe("calls", () => {
  const v = ref("local", "v", FX_VALUE_TYPES.vec3);

  it("default printing uses the function name", () => {
    expect(glsl(call("sin", v))).toBe("sin(v)");
  });

  it("string glsl override renames the builtin", () => {
    expect(glsl(call("atan2", lit(1), lit(2)))).toBe("atan(1.0, 2.0)");
  });

  it("template glsl override expands", () => {
    expect(glsl(call("saturate", v))).toBe("clamp(v, 0.0, 1.0)");
  });

  it("round prints as floor(x + 0.5) (GLSL ES 1.00 has no round; N2)", () => {
    expect(glsl(call("round", lit(2.4)))).toBe("floor(2.4 + 0.5)");
  });

  it("unknown functions throw", () => {
    const bogus = { kind: "call", type: FX_VALUE_TYPES.float, fn: "nope", args: [] } as const;
    expect(() => printGLSLBaseline(bogus, FX_FUNCTIONS)).toThrow(/unknown function/);
  });

  it("collects glsl helpers once", () => {
    const fns = new Map<string, FXFunctionDef>([
      [
        "noise",
        {
          name: "noise",
          signatures: [{ args: ["vec3"], result: "float" }],
          glslBaselineHelper: "float noise(vec3 p) { return 0.0; }",
          js: () => "0",
        },
      ],
    ]);
    const noiseCall = { kind: "call", type: FX_VALUE_TYPES.float, fn: "noise", args: [v] } as const;
    const result = printGLSLBaseline(noiseCall, fns);
    expect(result.code).toBe("noise(v)");
    expect(result.helpers.get("noise")).toContain("float noise");
  });
});

describe("swizzle, construct, raw", () => {
  const v = ref("local", "v", FX_VALUE_TYPES.vec4);

  it("swizzle wraps the source and appends channels", () => {
    expect(glsl(swizzle(v, "xy"))).toBe("(v).xy");
  });

  it("construct assembles the target vector", () => {
    expect(glsl(construct(FX_VALUE_TYPES.vec3, lit(1), swizzle(v, "yz")))).toBe(
      "vec3(1.0, (v).yz)",
    );
  });

  it("raw substitutes $i deps and rejects the wrong language", () => {
    expect(glsl(raw(FX_VALUE_TYPES.float, "glsl", "($0 + $1)", lit(1), lit(2)))).toBe(
      "(1.0 + 2.0)",
    );
    expect(() => glsl(raw(FX_VALUE_TYPES.float, "js", "x", lit(1)))).toThrow(
      /not printable as GLSL/,
    );
  });
});

describe("glslFloat (T11)", () => {
  it("prints plain numbers with a decimal point", () => {
    expect(glslFloat(1)).toBe("1.0");
    expect(glslFloat(1.5)).toBe("1.5");
  });

  it("leaves exponent-form numbers alone (no trailing .0)", () => {
    expect(glslFloat(1e21)).toBe("1e+21");
    expect(glslFloat(1e-21)).toBe("1e-21");
  });

  it("throws a typed glsl-float-not-finite on non-finite values", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      let caught: unknown;
      try {
        glslFloat(value);
      } catch (error) {
        caught = error;
      }
      expect(isFXCompilerErrorException(caught)).toBe(true);
      if (isFXCompilerErrorException(caught)) {
        expect(caught.error.code).toBe("glsl-float-not-finite");
      }
    }
  });
});
