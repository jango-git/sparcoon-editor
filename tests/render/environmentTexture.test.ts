import { describe, expect, it } from "vitest";
import { downsampleEquirect, wrapBackgroundTexture } from "../../src/render/environmentTexture";

const BACKGROUND_WIDTH = 128;
const BACKGROUND_HEIGHT = 64;

/** A 4x2 RGBA source where each texel's red channel is its flat index - easy to trace a sample. */
function indexedSource(): { data: Float32Array; width: number; height: number } {
  const width = 4;
  const height = 2;
  const data = new Float32Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = i;
    data[i * 4 + 1] = 1;
    data[i * 4 + 2] = 2;
    data[i * 4 + 3] = 3;
  }
  return { data, width, height };
}

describe("downsampleEquirect", () => {
  it("returns RGBA float data sized for the target resolution", () => {
    const result = downsampleEquirect(indexedSource(), 2, 1);
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(2 * 1 * 4);
  });

  it("point-samples the nearest source texel per target texel", () => {
    // Downsampling 4x2 to 2x1: the single target row's center (y=0.5) maps to source row
    // floor(0.5/1 * 2) = 1; the two target columns' centers map to source x floor(0.5/2 * 4) = 1
    // and floor(1.5/2 * 4) = 3 - source texel indices (row*4+x) 5 and 7.
    const result = downsampleEquirect(indexedSource(), 2, 1);
    expect(result[0]).toBe(5); // source texel index 5
    expect(result[4]).toBe(7); // source texel index 7
  });

  it("is an identity resize when the target matches the source resolution", () => {
    const source = indexedSource();
    const result = downsampleEquirect(source, source.width, source.height);
    expect(Array.from(result)).toEqual(Array.from(source.data));
  });

  it("clamps to the last row/column instead of reading out of bounds", () => {
    const result = downsampleEquirect(indexedSource(), 9, 5);
    expect(result.length).toBe(9 * 5 * 4);
    expect(Array.from(result)).not.toContain(NaN);
  });
});

describe("wrapBackgroundTexture", () => {
  it("sets flipY to match RGBELoader's full texture, so background isn't mirrored relative to it", () => {
    const data = new Float32Array(BACKGROUND_WIDTH * BACKGROUND_HEIGHT * 4);
    const texture = wrapBackgroundTexture(data);
    expect(texture.flipY).toBe(true);
  });
});
