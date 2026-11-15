import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { decodeGrayPng, encodeGrayPng } from "../../src/util/grayPng";

/** A PNG of `rows`, each row filtered by its own filter type, its CRCs left zero. */
function pngOf(width: number, rows: readonly { filter: number; bytes: number[] }[]): Uint8Array {
  const chunk = (type: string, data: Uint8Array): number[] => {
    const length = [24, 16, 8, 0].map((shift) => (data.length >>> shift) & 0xff);
    return [...length, ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
  };
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, width);
  new DataView(header.buffer).setUint32(4, rows.length);
  header[8] = 8;
  const raw = Uint8Array.from(rows.flatMap((row) => [row.filter, ...row.bytes]));
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk("IHDR", header),
    ...chunk("IDAT", deflateSync(raw)),
    ...chunk("IEND", new Uint8Array(0)),
  ]);
}

describe("grayPng", () => {
  it("decodes what it encodes, byte for byte", async () => {
    const pixels = Uint8Array.from({ length: 37 * 19 }, (_, i) => (i * 7919 + (i >> 3)) & 0xff);
    const file = await encodeGrayPng({ width: 37, height: 19, pixels });
    const image = await decodeGrayPng(file);
    expect([image.width, image.height]).toEqual([37, 19]);
    expect([...image.pixels]).toEqual([...pixels]);
  });

  it("undoes every PNG filter", async () => {
    // Rows of [10, 20, 30] filtered as none, sub, up, average and Paeth.
    const image = await decodeGrayPng(
      pngOf(3, [
        { filter: 0, bytes: [10, 20, 30] },
        { filter: 1, bytes: [10, 10, 10] },
        { filter: 2, bytes: [0, 0, 0] },
        { filter: 3, bytes: [5, 5, 5] },
        { filter: 4, bytes: [0, 0, 0] },
      ]),
    );
    expect([...image.pixels]).toEqual([10, 20, 30, 10, 20, 30, 10, 20, 30, 10, 20, 30, 10, 20, 30]);
  });

  it("refuses a file that is not an 8-bit grayscale PNG", async () => {
    await expect(decodeGrayPng(Uint8Array.from([1, 2, 3]))).rejects.toThrow(/not a PNG/);
    const rgb = pngOf(1, [{ filter: 0, bytes: [0] }]);
    rgb[8 + 8 + 9] = 2;
    await expect(decodeGrayPng(rgb)).rejects.toThrow(/8-bit grayscale/);
  });
});
