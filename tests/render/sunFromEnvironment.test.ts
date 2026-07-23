import { describe, expect, it } from "vitest";
import { deriveSunFromEquirect } from "../../src/render/sunFromEnvironment";

const WIDTH = 32;
const HEIGHT = 16;

/** A uniform dim RGBA image, so a single planted bright texel is the clear upper-hemisphere winner. */
function dimImage(): { data: Float32Array; width: number; height: number } {
  const data = new Float32Array(WIDTH * HEIGHT * 4);
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    data[i * 4] = 0.01;
    data[i * 4 + 1] = 0.01;
    data[i * 4 + 2] = 0.01;
    data[i * 4 + 3] = 1;
  }
  return { data, width: WIDTH, height: HEIGHT };
}

function plantTexel(
  image: { data: Float32Array; width: number; height: number },
  row: number,
  column: number,
  r: number,
  g: number,
  b: number,
): void {
  const index = (row * image.width + column) * 4;
  image.data[index] = r;
  image.data[index + 1] = g;
  image.data[index + 2] = b;
  image.data[index + 3] = 1;
}

/** Inverse of deriveSunFromEquirect's azimuth/elevation formula, for round-tripping the math. */
function rowColumnFor(
  azimuthDegrees: number,
  elevationDegrees: number,
): { row: number; column: number } {
  const rowFraction = (90 - elevationDegrees) / 180;
  const normalizedAzimuth = (((270 - azimuthDegrees) % 360) + 360) % 360;
  const columnFraction = normalizedAzimuth / 360;
  return {
    row: Math.min(HEIGHT - 1, Math.floor(rowFraction * HEIGHT)),
    column: Math.min(WIDTH - 1, Math.floor(columnFraction * WIDTH)),
  };
}

describe("deriveSunFromEquirect", () => {
  it("ignores a brighter texel planted in the lower hemisphere", () => {
    const image = dimImage();
    plantTexel(image, HEIGHT - 1, 0, 500, 500, 500); // bottom row: below the horizon
    plantTexel(image, 2, 10, 50, 50, 50); // upper hemisphere: dimmer, but the only eligible one
    const derived = deriveSunFromEquirect(image);
    expect(derived.elevation).toBeGreaterThan(0);
  });

  it("round-trips azimuth/elevation through a planted bright texel", () => {
    // One texel spans 180/HEIGHT degrees of elevation and 360/WIDTH degrees of azimuth - the
    // recovered angle can only be that precise, not exact.
    const elevationTolerance = 180 / HEIGHT;
    const azimuthTolerance = 360 / WIDTH;
    for (const [azimuth, elevation] of [
      [45, 60],
      [270, 5],
      [10, 85],
      [190, 30],
    ] as const) {
      const image = dimImage();
      const { row, column } = rowColumnFor(azimuth, elevation);
      plantTexel(image, row, column, 800, 800, 800);
      const derived = deriveSunFromEquirect(image);
      expect(Math.abs(derived.elevation - elevation)).toBeLessThanOrEqual(elevationTolerance);
      expect(Math.abs(derived.azimuth - azimuth)).toBeLessThanOrEqual(azimuthTolerance);
    }
  });

  it("splits a bright HDR texel into a hue-preserving color and a bounded intensity", () => {
    const image = dimImage();
    plantTexel(image, 1, 1, 500, 100, 50);
    const derived = deriveSunFromEquirect(image);
    expect(derived.color[0]).toBeLessThanOrEqual(1);
    expect(derived.color[1]).toBeLessThanOrEqual(1);
    expect(derived.color[2]).toBeLessThanOrEqual(1);
    expect(derived.color[0] / derived.color[1]).toBeCloseTo(500 / 100, 1);
    expect(Number.isFinite(derived.intensity)).toBe(true);
    expect(derived.intensity).toBeLessThanOrEqual(10);
  });

  it("disables the sun when the upper hemisphere has no clear bright spot", () => {
    const data = new Float32Array(WIDTH * HEIGHT * 4);
    data.fill(0.2);
    const derived = deriveSunFromEquirect({ data, width: WIDTH, height: HEIGHT });
    expect(derived.enabled).toBe(false);
  });

  it("enables the sun when one texel is far brighter than the rest", () => {
    const image = dimImage();
    plantTexel(image, 1, 1, 1000, 1000, 1000);
    const derived = deriveSunFromEquirect(image);
    expect(derived.enabled).toBe(true);
  });

  it("produces no NaN/Infinity on an all-black image", () => {
    const data = new Float32Array(WIDTH * HEIGHT * 4);
    const derived = deriveSunFromEquirect({ data, width: WIDTH, height: HEIGHT });
    expect(Number.isFinite(derived.azimuth)).toBe(true);
    expect(Number.isFinite(derived.elevation)).toBe(true);
    expect(Number.isFinite(derived.intensity)).toBe(true);
    expect(derived.color.every((channel) => Number.isFinite(channel))).toBe(true);
  });
});
