import { crc32 } from "node:zlib";

import { describe, expect, it } from "vitest";

import { writeZip } from "../../src/util/zip";
import { readZip } from "../helpers/zip";

describe("writeZip", () => {
  it("stores and deflates files that zlib reads back with their CRCs", async () => {
    const repetitive = new Uint8Array(4096).map((_, index) => index % 7);
    const random = Uint8Array.from({ length: 64 }, (_, index) => (index * 151 + 17) % 256);
    const archive = await writeZip([
      { name: "a.png", bytes: random, deflate: false },
      { name: "b.glb", bytes: repetitive, deflate: true },
    ]);
    const [stored, deflated] = readZip(archive);
    expect(stored).toMatchObject({ name: "a.png", method: 0 });
    expect(deflated).toMatchObject({ name: "b.glb", method: 8 });
    expect(stored.bytes).toEqual(random);
    expect(deflated.bytes).toEqual(repetitive);
    expect(stored.crc).toBe(crc32(random));
    expect(deflated.crc).toBe(crc32(repetitive));
  });

  it("stores a file that deflate would not shrink", async () => {
    const [entry] = readZip(
      await writeZip([{ name: "tiny", bytes: Uint8Array.of(1, 2, 3), deflate: true }]),
    );
    expect(entry.method).toBe(0);
    expect(entry.bytes).toEqual(Uint8Array.of(1, 2, 3));
  });

  it("names files in UTF-8 and marks it", async () => {
    const [entry] = readZip(
      await writeZip([{ name: "Сфера SDF 8x8x8.png", bytes: new Uint8Array(1), deflate: false }]),
    );
    expect(entry.name).toBe("Сфера SDF 8x8x8.png");
    expect(entry.flags).toBe(0x0800);
  });

  it("writes an empty archive", async () => {
    expect(readZip(await writeZip([]))).toEqual([]);
  });
});
