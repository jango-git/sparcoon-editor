import { describe, expect, it } from "vitest";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { FX_FUNCTIONS } from "../../src/engine/core/ir/FXFunctions.Internal";
import { printGLSLBaseline } from "../../src/engine/core/codegen/printGLSLBaseline.Internal";
import type { FXCallSignature } from "../../src/engine/core/ir/FXExprBuilder";
import {
  add,
  coerceNumeric,
  construct,
  createCall,
  div,
  eq,
  lit,
  litInt,
  litVec,
  lt,
  mod,
  mul,
  neg,
  raw,
  ref,
  select,
  sub,
  swizzle,
  toFloat,
  toInt,
} from "../../src/engine/core/ir/FXExprBuilder";

describe("literals and refs", () => {
  it("lit is a float carrying its value", () => {
    const e = lit(2.5);
    expect(e).toMatchObject({ kind: "lit", type: FX_VALUE_TYPES.float, values: [2.5] });
  });

  it("litVec sizes the type by component count", () => {
    expect(litVec(1, 2).type).toBe(FX_VALUE_TYPES.vec2);
    expect(litVec(1, 2, 3).type).toBe(FX_VALUE_TYPES.vec3);
    expect(litVec(1, 2, 3, 4).type).toBe(FX_VALUE_TYPES.vec4);
  });

  it("litVec rejects out-of-range widths", () => {
    expect(() => litVec(1)).toThrow(/2\.\.4/);
    expect(() => litVec(1, 2, 3, 4, 5)).toThrow(/2\.\.4/);
  });

  it("ref carries kind, name and type", () => {
    expect(ref("uniform", "p_tint", FX_VALUE_TYPES.vec4)).toMatchObject({
      kind: "ref",
      ref: "uniform",
      name: "p_tint",
      type: FX_VALUE_TYPES.vec4,
    });
  });
});

describe("coerceNumeric", () => {
  const glsl = (expr: Parameters<typeof printGLSLBaseline>[0]): string =>
    printGLSLBaseline(expr, FX_FUNCTIONS).code;
  const v = (name: string, type: keyof typeof FX_VALUE_TYPES) =>
    ref("local", name, FX_VALUE_TYPES[type]);

  it("returns the expression unchanged when the type already matches", () => {
    const e = v("a", "vec3");
    expect(coerceNumeric(e, FX_VALUE_TYPES.vec3)).toBe(e);
  });

  it("splats a float into every component of a vector", () => {
    const out = coerceNumeric(v("s", "float"), FX_VALUE_TYPES.vec3);
    expect(out.type).toBe(FX_VALUE_TYPES.vec3);
    expect(glsl(out)).toBe("vec3(s, s, s)");
  });

  it("narrows a vector to a float by taking its first component", () => {
    const out = coerceNumeric(v("a", "vec4"), FX_VALUE_TYPES.float);
    expect(out.type).toBe(FX_VALUE_TYPES.float);
    expect(glsl(out)).toBe("(a).x");
  });

  it("pads a narrower vector's missing tail with zeros", () => {
    const out = coerceNumeric(v("a", "vec2"), FX_VALUE_TYPES.vec4);
    expect(out.type).toBe(FX_VALUE_TYPES.vec4);
    expect(glsl(out)).toBe("vec4(a, 0.0, 0.0)");
  });

  it("truncates a wider vector to the target width", () => {
    const out = coerceNumeric(v("a", "vec4"), FX_VALUE_TYPES.vec2);
    expect(out.type).toBe(FX_VALUE_TYPES.vec2);
    expect(glsl(out)).toBe("(a).xy");
  });

  it("throws when a non-numeric type has no meaningful conversion", () => {
    expect(() => coerceNumeric(v("t", "sampler2D"), FX_VALUE_TYPES.vec3)).toThrow(/convert/);
  });

  it("never implicitly converts int<->float, even when components line up", () => {
    const i = ref("local", "i", FX_VALUE_TYPES.int);
    const iv = ref("local", "iv", FX_VALUE_TYPES.ivec2);
    expect(() => coerceNumeric(i, FX_VALUE_TYPES.float)).toThrow(/explicit int\/float cast/);
    // Same component count (2) as vec2 - the exact silent-coercion path this guard closes.
    expect(() => coerceNumeric(iv, FX_VALUE_TYPES.vec2)).toThrow(/explicit int\/float cast/);
  });
});

describe("int/ivecN arithmetic (tier-neutral: +/-/* are valid GLSL for int in both baseline/standard)", () => {
  it("same-family int arithmetic type-checks", () => {
    expect(add(litInt(1), litInt(2)).type).toBe(FX_VALUE_TYPES.int);
    expect(mul(litInt(3), litInt(4)).type).toBe(FX_VALUE_TYPES.int);
  });

  it("rejects int mixed with float (no implicit splat/coercion)", () => {
    expect(() => add(litInt(1), lit(2))).toThrow(/type mismatch|expects float/);
  });

  it("rejects mod on int (GLSL's mod() has no integer overload)", () => {
    expect(() => mod(litInt(7), litInt(2))).toThrow(/mod is not defined for int/);
  });

  it("toInt/toFloat cast explicitly and reject the wrong source type", () => {
    const casted = toInt(lit(1.5));
    expect(casted.type).toBe(FX_VALUE_TYPES.int);
    expect(() => toInt(litInt(1))).toThrow(/toInt expects a float/);
    expect(toFloat(litInt(2)).type).toBe(FX_VALUE_TYPES.float);
    expect(() => toFloat(lit(1))).toThrow(/toFloat expects an int/);
  });
});

describe("arithmetic type resolution", () => {
  it("T op T -> T", () => {
    expect(add(lit(1), lit(2)).type).toBe(FX_VALUE_TYPES.float);
    expect(mul(litVec(1, 2, 3), litVec(4, 5, 6)).type).toBe(FX_VALUE_TYPES.vec3);
  });

  it("vecN op float -> vecN for every arithmetic op", () => {
    const v = litVec(1, 2, 3);
    expect(add(v, lit(1)).type).toBe(FX_VALUE_TYPES.vec3);
    expect(sub(v, lit(1)).type).toBe(FX_VALUE_TYPES.vec3);
    expect(mul(v, lit(1)).type).toBe(FX_VALUE_TYPES.vec3);
    expect(div(v, lit(1)).type).toBe(FX_VALUE_TYPES.vec3);
    expect(mod(v, lit(1)).type).toBe(FX_VALUE_TYPES.vec3);
  });

  it("float op vecN -> vecN only for add and mul", () => {
    const v = litVec(1, 2, 3);
    expect(add(lit(1), v).type).toBe(FX_VALUE_TYPES.vec3);
    expect(mul(lit(1), v).type).toBe(FX_VALUE_TYPES.vec3);
    expect(() => sub(lit(1), v)).toThrow(/splat/);
    expect(() => div(lit(1), v)).toThrow(/splat/);
  });

  it("rejects mismatched vector widths and non-numeric operands", () => {
    expect(() => add(litVec(1, 2), litVec(1, 2, 3))).toThrow(/mismatch/);
    // A matrix operand takes the dedicated matrix rules: add(mat3, float) is rejected there
    // (only matN +/- matN is defined), not by the float/vecN guard.
    expect(() => add(ref("uniform", "m", FX_VALUE_TYPES.mat3), lit(1))).toThrow(/matrices/);
  });
});

describe("comparisons", () => {
  it("float x float -> float", () => {
    expect(lt(lit(1), lit(2)).type).toBe(FX_VALUE_TYPES.float);
    expect(eq(lit(1), lit(2)).type).toBe(FX_VALUE_TYPES.float);
  });

  it("rejects vector operands", () => {
    expect(() => lt(litVec(1, 2), litVec(3, 4))).toThrow(/float operands/);
  });
});

describe("unary", () => {
  it("neg preserves the operand type", () => {
    expect(neg(litVec(1, 2, 3)).type).toBe(FX_VALUE_TYPES.vec3);
  });

  it("neg rejects non-numeric operands", () => {
    expect(() => neg(ref("uniform", "s", FX_VALUE_TYPES.sampler2D))).toThrow(/float\/vecN/);
  });
});

describe("swizzle", () => {
  it("channel count fixes the result type", () => {
    const v = litVec(1, 2, 3, 4);
    expect(swizzle(v, "x").type).toBe(FX_VALUE_TYPES.float);
    expect(swizzle(v, "xy").type).toBe(FX_VALUE_TYPES.vec2);
    expect(swizzle(v, "wzyx").type).toBe(FX_VALUE_TYPES.vec4);
  });

  it("rejects channels beyond the source width and bad channel names", () => {
    expect(() => swizzle(litVec(1, 2), "z")).toThrow(/out of range/);
    expect(() => swizzle(litVec(1, 2, 3), "q")).toThrow(/invalid swizzle channel/);
    expect(() => swizzle(litVec(1, 2), "xyzwx")).toThrow(/1\.\.4/);
  });

  it("rejects a scalar source (a `.x` on a float is invalid GLSL)", () => {
    expect(() => swizzle(lit(1), "x")).toThrow(/vec2\/vec3\/vec4 source/);
  });
});

describe("construct", () => {
  it("accepts scalars and shorter vectors summing to the width", () => {
    expect(construct(FX_VALUE_TYPES.vec3, lit(1), lit(2), lit(3)).type).toBe(FX_VALUE_TYPES.vec3);
    expect(construct(FX_VALUE_TYPES.vec4, litVec(1, 2), litVec(3, 4)).type).toBe(
      FX_VALUE_TYPES.vec4,
    );
  });

  it("rejects component-count mismatches and non-vector targets", () => {
    expect(() => construct(FX_VALUE_TYPES.vec3, lit(1), lit(2))).toThrow(/needs 3 components/);
    expect(() => construct(FX_VALUE_TYPES.float, lit(1))).toThrow(/vec2\/vec3\/vec4/);
  });
});

describe("select", () => {
  it("float cond with matching branches", () => {
    expect(select(lit(1), litVec(1, 2, 3), litVec(4, 5, 6)).type).toBe(FX_VALUE_TYPES.vec3);
  });

  it("rejects non-float cond and mismatched branches", () => {
    expect(() => select(litVec(1, 2), lit(1), lit(2))).toThrow(/condition must be float/);
    expect(() => select(lit(1), litVec(1, 2), lit(3))).toThrow(/share a type/);
  });
});

describe("raw", () => {
  it("declares its own type and keeps deps in order", () => {
    const e = raw(FX_VALUE_TYPES.vec2, "glsl", "vec2($0, $1)", lit(1), lit(2));
    expect(e).toMatchObject({ kind: "raw", type: FX_VALUE_TYPES.vec2, language: "glsl" });
    expect((e as { deps: unknown[] }).deps).toHaveLength(2);
  });
});

describe("call", () => {
  it("resolves the result type from a matching registered signature", () => {
    const call = createCall(
      new Map<string, readonly FXCallSignature[]>([
        [
          "testMix",
          [
            { args: ["vec3", "vec3", "float"], result: "vec3" },
            { args: ["float", "float", "float"], result: "float" },
          ],
        ],
      ]),
    );
    expect(call("testMix", litVec(1, 2, 3), litVec(4, 5, 6), lit(0.5)).type).toBe(
      FX_VALUE_TYPES.vec3,
    );
    expect(call("testMix", lit(1), lit(2), lit(0.5)).type).toBe(FX_VALUE_TYPES.float);
  });

  it("throws on unknown functions and unmatched signatures", () => {
    const call = createCall(
      new Map<string, readonly FXCallSignature[]>([
        ["testAbs", [{ args: ["float"], result: "float" }]],
      ]),
    );
    expect(() => call("nopeFn", lit(1))).toThrow(/unknown function/);
    expect(() => call("testAbs", litVec(1, 2))).toThrow(/no signature/);
  });
});
