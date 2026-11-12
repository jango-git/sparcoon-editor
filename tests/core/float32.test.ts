import { describe, expect, it } from "vitest";
import { shortestFloat32 } from "../../src/engine/core/codegen/float32.Internal";
import { printJS } from "../../src/engine/core/codegen/printJS.Internal";
import { lit } from "../../src/engine/core/ir/FXExprBuilder";
import { FX_FUNCTIONS } from "../../src/engine/core/ir/FXFunctions.Internal";
import { glslFloat } from "../../src/engine/core/codegen/printGLSL.Internal";

describe("shortestFloat32", () => {
  it("spells a double by the shortest decimal of the same 32-bit float", () => {
    expect(shortestFloat32(0.30624999999999997)).toBe("0.30625");
    expect(shortestFloat32(2.857142857142857)).toBe("2.857143");
    expect(shortestFloat32(Math.PI * 2)).toBe("6.2831853");
    for (const value of [0.30624999999999997, 1 / 3, 1e-7, 123456.789, -0.15000000000000002]) {
      expect(Math.fround(Number(shortestFloat32(value)))).toBe(Math.fround(value));
    }
  });

  it("never lengthens a spelling, and keeps a short one as it is", () => {
    expect(shortestFloat32(0.5)).toBe("0.5");
    expect(shortestFloat32(3)).toBe("3");
    expect(shortestFloat32(1e21)).toBe("1e+21");
  });
});

describe("glslFloat", () => {
  it("prints the shortest float32 spelling, a whole number with its point", () => {
    expect(glslFloat(0.30624999999999997)).toBe("0.30625");
    expect(glslFloat(3)).toBe("3.0");
    expect(glslFloat(16777217)).toBe("16777217.0"); // the same float32 as 16777216, no shorter
    expect(glslFloat(1e-7)).toBe("1e-7");
  });
});

describe("printJS literals", () => {
  it("spells a fraction as the GPU kernel does, an integer as it is", () => {
    const js = (value: number): string => printJS(lit(value), FX_FUNCTIONS).code;
    expect(js(0.30624999999999997)).toBe("0.30625");
    expect(js(-0.15000000000000002)).toBe("-0.15");
    expect(js(16777217)).toBe("16777217");
    expect(js(6)).toBe("6");
  });
});
