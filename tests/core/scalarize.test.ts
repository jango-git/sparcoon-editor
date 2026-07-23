import { describe, expect, it } from "vitest";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { FX_FUNCTIONS } from "../../src/engine/core/ir/FXFunctions.Internal";
import { scalarize } from "../../src/engine/core/codegen/scalarize.Internal";
import { printJS } from "../../src/engine/core/codegen/printJS.Internal";
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

/** Scalarize then print each component - exercises both files at once. */
function jsComponents(expr: Parameters<typeof scalarize>[0]): string[] {
  return scalarize(expr).map((component) => printJS(component, FX_FUNCTIONS).code);
}

const v3 = (name: string): ReturnType<typeof ref> => ref("local", name, FX_VALUE_TYPES.vec3);
const f = (name: string): ReturnType<typeof ref> => ref("local", name, FX_VALUE_TYPES.float);

describe("component expansion", () => {
  it("vector literal -> one float per component", () => {
    expect(jsComponents(litVec(1, 2, 3))).toEqual(["1", "2", "3"]);
  });

  it("vector ref -> named component refs", () => {
    expect(jsComponents(v3("v"))).toEqual(["v_x", "v_y", "v_z"]);
  });

  it("scalar ref passes through", () => {
    expect(jsComponents(f("a"))).toEqual(["a"]);
  });

  it("swizzle selects components", () => {
    expect(jsComponents(swizzle(ref("local", "v", FX_VALUE_TYPES.vec4), "zx"))).toEqual([
      "v_z",
      "v_x",
    ]);
  });

  it("construct concatenates component streams", () => {
    expect(jsComponents(construct(FX_VALUE_TYPES.vec3, litVec(1, 2), lit(3)))).toEqual([
      "1",
      "2",
      "3",
    ]);
  });
});

describe("elementwise ops with splat", () => {
  it("vecN + float splats the scalar across components", () => {
    expect(jsComponents(add(v3("v"), lit(10)))).toEqual(["(v_x + 10)", "(v_y + 10)", "(v_z + 10)"]);
  });

  it("vecN + vecN is component-wise", () => {
    expect(jsComponents(add(v3("a"), v3("b")))).toEqual([
      "(a_x + b_x)",
      "(a_y + b_y)",
      "(a_z + b_z)",
    ]);
  });

  it("neg maps over components", () => {
    expect(jsComponents(neg(litVec(1, 2)))).toEqual(["(- 1)", "(- 2)"]);
  });

  it("neg of negative components stays valid JS (no `--`)", () => {
    const printed = jsComponents(neg(litVec(-1, -2)));
    expect(printed).toEqual(["(- -1)", "(- -2)"]);
    // The emitted source must parse: `(--1)` would be a SyntaxError in `new Function`.
    for (const code of printed) {
      expect(new Function(`return ${code};`)()).toBeTypeOf("number");
    }
  });

  it("element-wise calls map over components", () => {
    expect(jsComponents(call("sin", v3("v")))).toEqual([
      "Math.sin(v_x)",
      "Math.sin(v_y)",
      "Math.sin(v_z)",
    ]);
  });

  it("mix splats its scalar t and pulls in the helper", () => {
    const results = scalarize(call("mix", v3("a"), v3("b"), lit(0.5))).map((c) =>
      printJS(c, FX_FUNCTIONS),
    );
    expect(results.map((r) => r.code)).toEqual([
      "fxMix(a_x, b_x, 0.5)",
      "fxMix(a_y, b_y, 0.5)",
      "fxMix(a_z, b_z, 0.5)",
    ]);
    expect(results[0].helpers.get("mix")).toContain("function fxMix");
  });
});

describe("vector reductions", () => {
  it("length -> sqrt of the sum of squares", () => {
    const [code] = jsComponents(call("length", v3("v")));
    expect(code).toContain("Math.sqrt");
    expect(code).toContain("(v_x * v_x)");
    expect(code).toContain("(v_z * v_z)");
    expect(jsComponents(call("length", v3("v")))).toHaveLength(1);
  });

  it("dot -> sum of products", () => {
    expect(
      jsComponents(
        call("dot", ref("local", "a", FX_VALUE_TYPES.vec2), ref("local", "b", FX_VALUE_TYPES.vec2)),
      ),
    ).toEqual(["((a_x * b_x) + (a_y * b_y))"]);
  });

  it("normalize -> each component divided by the magnitude", () => {
    const parts = jsComponents(call("normalize", ref("local", "v", FX_VALUE_TYPES.vec2)));
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain("v_x /");
    expect(parts[0]).toContain("Math.sqrt");
  });

  it("cross -> the three vec3 determinant components", () => {
    expect(jsComponents(call("cross", v3("a"), v3("b")))).toEqual([
      "((a_y * b_z) - (a_z * b_y))",
      "((a_z * b_x) - (a_x * b_z))",
      "((a_x * b_y) - (a_y * b_x))",
    ]);
  });
});

describe("select, mod, raw", () => {
  it("select broadcasts one condition across components", () => {
    expect(jsComponents(select(lt(f("a"), f("b")), v3("p"), v3("q")))).toEqual([
      "((a < b ? 1 : 0) !== 0 ? p_x : q_x)",
      "((a < b ? 1 : 0) !== 0 ? p_y : q_y)",
      "((a < b ? 1 : 0) !== 0 ? p_z : q_z)",
    ]);
  });

  it("mod bin uses the fxMod helper", () => {
    const [result] = scalarize(mod(f("a"), f("b"))).map((c) => printJS(c, FX_FUNCTIONS));
    expect(result.code).toBe("fxMod(a, b)");
    expect(result.helpers.get("mod")).toContain("function fxMod");
  });

  it("scalar raw(js) substitutes deps", () => {
    expect(jsComponents(raw(FX_VALUE_TYPES.float, "js", "$0 * 2", f("a")))).toEqual(["a * 2"]);
  });

  it("vector raw cannot be scalarized", () => {
    expect(() => scalarize(raw(FX_VALUE_TYPES.vec3, "js", "x"))).toThrow(/cannot be scalarized/);
  });
});

describe("printJS guards", () => {
  it("rejects unknown functions", () => {
    const bogus = { kind: "call", type: FX_VALUE_TYPES.float, fn: "texSample", args: [] } as const;
    expect(() => printJS(bogus, FX_FUNCTIONS)).toThrow(/unknown function/);
  });

  it("rejects a non-scalar literal", () => {
    expect(() => printJS(litVec(1, 2, 3), FX_FUNCTIONS)).toThrow(/non-scalar/);
  });

  it("rejects raw glsl", () => {
    expect(() => printJS(raw(FX_VALUE_TYPES.float, "glsl", "x"), FX_FUNCTIONS)).toThrow(
      /not printable as JS/,
    );
  });
});
