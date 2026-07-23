import { describe, expect, it } from "vitest";
import {
  hsvToRgb,
  linearToSrgb,
  linearToSrgbRgba,
  parseHex,
  rgbToHex,
  rgbToHsv,
  srgbToLinear,
  srgbToLinearRgba,
  type Rgba,
} from "../../src/ui/components/color";

/**
 * Pure color-space math backing the color-picker / color-ramp controls. The controls hold
 * sRGB working state but the engine stores linear RGBA, so these conversions run on every
 * edit; a round-trip drift would silently shift authored colors. (The DOM controls
 * themselves have no test env - see the editor-test-infra note - so this pins the math.)
 */

describe("sRGB <-> linear", () => {
  it("anchors the endpoints and stays monotonic", () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 6);
    expect(linearToSrgb(0)).toBe(0);
    expect(linearToSrgb(1)).toBeCloseTo(1, 6);
    // sRGB is gamma-encoded: mid-grey 0.5 sits below linear 0.5.
    expect(srgbToLinear(0.5)).toBeLessThan(0.5);
  });

  it("round-trips per channel", () => {
    for (const c of [0, 0.02, 0.04045, 0.25, 0.5, 0.75, 1]) {
      expect(linearToSrgb(srgbToLinear(c))).toBeCloseTo(c, 6);
      expect(srgbToLinear(linearToSrgb(c))).toBeCloseTo(c, 6);
    }
  });

  it("round-trips RGBA and leaves alpha ungamma'd", () => {
    const srgb: Rgba = [0.2, 0.6, 0.9, 0.35];
    const linear = srgbToLinearRgba(srgb);
    expect(linear[3]).toBe(0.35); // alpha passes through untouched
    const back = linearToSrgbRgba(linear);
    expect(back[0]).toBeCloseTo(0.2, 6);
    expect(back[1]).toBeCloseTo(0.6, 6);
    expect(back[2]).toBeCloseTo(0.9, 6);
    expect(back[3]).toBe(0.35);
  });
});

describe("HSV <-> RGB", () => {
  it("maps the primary hues", () => {
    expect(hsvToRgb(0, 1, 1)).toEqual([1, 0, 0]); // red
    expect(hsvToRgb(120, 1, 1)).toEqual([0, 1, 0]); // green
    expect(hsvToRgb(240, 1, 1)).toEqual([0, 0, 1]); // blue
    expect(hsvToRgb(0, 0, 1)).toEqual([1, 1, 1]); // white (no saturation)
    expect(hsvToRgb(0, 0, 0)).toEqual([0, 0, 0]); // black
  });

  it("round-trips saturated and pastel colors", () => {
    for (const [h, s, v] of [
      [30, 0.8, 0.9],
      [200, 0.5, 0.6],
      [330, 1, 0.4],
    ] as const) {
      const [r, g, b] = hsvToRgb(h, s, v);
      const [h2, s2, v2] = rgbToHsv(r, g, b);
      expect(h2).toBeCloseTo(h, 4);
      expect(s2).toBeCloseTo(s, 6);
      expect(v2).toBeCloseTo(v, 6);
    }
  });
});

describe("hex parsing / formatting", () => {
  it("formats rgb and rgba", () => {
    expect(rgbToHex([1, 0, 0])).toBe("#ff0000");
    expect(rgbToHex([0, 0, 0], 1)).toBe("#000000ff");
    expect(rgbToHex([1, 1, 1], 0)).toBe("#ffffff00");
  });

  it("parses #rgb / #rrggbb / #rrggbbaa (with or without #)", () => {
    expect(parseHex("#f00")).toEqual([1, 0, 0, 1]);
    expect(parseHex("00ff00")).toEqual([0, 1, 0, 1]);
    const rgba = parseHex("#0000ff80")!;
    expect(rgba[0]).toBe(0);
    expect(rgba[2]).toBe(1);
    expect(rgba[3]).toBeCloseTo(128 / 255, 6);
  });

  it("rejects malformed hex as undefined", () => {
    expect(parseHex("nope")).toBeUndefined();
    expect(parseHex("#12")).toBeUndefined();
    expect(parseHex("#1234567")).toBeUndefined();
    expect(parseHex("")).toBeUndefined();
  });

  it("round-trips a color through hex", () => {
    const hex = rgbToHex([0.2, 0.4, 0.6], 0.8);
    const parsed = parseHex(hex)!;
    expect(parsed[0]).toBeCloseTo(0.2, 2);
    expect(parsed[1]).toBeCloseTo(0.4, 2);
    expect(parsed[2]).toBeCloseTo(0.6, 2);
    expect(parsed[3]).toBeCloseTo(0.8, 2);
  });
});
