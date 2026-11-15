import { inflateRawSync } from "node:zlib";

/** One file read back from an archive, as its central directory describes it. */
export interface ReadZipEntry {
  readonly name: string;
  readonly method: number;
  readonly flags: number;
  readonly crc: number;
  readonly bytes: Uint8Array;
}

/** The files of a zip archive, read through its central directory, inflated by Node's zlib. */
export function readZip(archive: Uint8Array): ReadZipEntry[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const end = archive.length - 22;
  if (view.getUint32(end, true) !== 0x06054b50) {
    throw new Error("readZip: no end of central directory record");
  }
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries: ReadZipEntry[] = [];
  for (let index = 0; index < count; index++) {
    if (view.getUint32(at, true) !== 0x02014b50) {
      throw new Error("readZip: bad central directory record");
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const packedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(archive.subarray(at + 46, at + 46 + nameLength));
    if (view.getUint32(local, true) !== 0x04034b50) {
      throw new Error("readZip: bad local header");
    }
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const packed = archive.subarray(start, start + packedSize);
    const bytes = method === 8 ? new Uint8Array(inflateRawSync(packed)) : packed;
    entries.push({ name, method, flags, crc, bytes });
    at += 46 + nameLength;
  }
  return entries;
}
