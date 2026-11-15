import { describe, expect, it } from "vitest";

import {
  atlasLayout,
  atlasToVolume,
  volumeAtlasDataUrl,
  volumeFromAtlasDataUrl,
  volumeToAtlas,
} from "../../src/domain/volumeAtlas";

const SIZE = [3, 2, 5] as const;
const TEXELS = Uint8Array.from({ length: 3 * 2 * 5 }, (_, i) => i * 8);

describe("volumeAtlas", () => {
  it("tiles the slices in rows of ceil(sqrt(depth)) columns", () => {
    expect(atlasLayout(SIZE)).toEqual({ columns: 3, rows: 2, width: 9, height: 4 });
    const image = volumeToAtlas({ size: SIZE, texels: TEXELS });
    // Slice 4 is the tile at column 1, row 1. Its texel (2, 1) is the pixel 3 + 2 across, 2 + 1 down.
    expect(image.pixels[(2 + 1) * image.width + 3 + 2]).toBe(TEXELS[2 + 3 * (1 + 2 * 4)]);
    // Past the last slice - black.
    expect(image.pixels[3 * image.width + 8]).toBe(0);
  });

  it("gives the texels back from the atlas, and from its data URL", async () => {
    expect([...atlasToVolume(volumeToAtlas({ size: SIZE, texels: TEXELS }), SIZE)]).toEqual([
      ...TEXELS,
    ]);
    const dataUrl = await volumeAtlasDataUrl({ size: SIZE, texels: TEXELS });
    expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect([...(await volumeFromAtlasDataUrl(dataUrl, SIZE))]).toEqual([...TEXELS]);
  });

  it("refuses an atlas of another size", async () => {
    const dataUrl = await volumeAtlasDataUrl({ size: SIZE, texels: TEXELS });
    await expect(volumeFromAtlasDataUrl(dataUrl, [3, 2, 4])).rejects.toThrow(/not the atlas/);
  });
});
