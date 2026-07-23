import { describe, expect, it } from "vitest";
import { tonemapToImageBytes } from "../../src/render/assetThumbnails";

describe("tonemapToImageBytes", () => {
  it("maps a zero-radiance pixel to opaque black", () => {
    const bytes = tonemapToImageBytes(new Float32Array([0, 0, 0, 1]));
    expect(Array.from(bytes)).toEqual([0, 0, 0, 255]);
  });

  it("compresses unbounded HDR radiance into the [0, 255] byte range", () => {
    const bytes = tonemapToImageBytes(new Float32Array([1e6, 50, 0.5, 1]));
    for (const channel of bytes) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(255);
    }
    // Reinhard (c / (1 + c)) saturates toward 1 as radiance grows - a huge value reads as
    // brighter than a merely bright one.
    expect(bytes[0]).toBeGreaterThan(bytes[1]);
  });

  it("clamps negative radiance instead of producing a negative byte", () => {
    const bytes = tonemapToImageBytes(new Float32Array([-5, -5, -5, 1]));
    expect(Array.from(bytes.subarray(0, 3))).toEqual([0, 0, 0]);
  });

  it("always writes a fully opaque alpha channel", () => {
    const bytes = tonemapToImageBytes(new Float32Array([1, 1, 1, 0, 2, 2, 2, 0]));
    expect(bytes[3]).toBe(255);
    expect(bytes[7]).toBe(255);
  });
});
