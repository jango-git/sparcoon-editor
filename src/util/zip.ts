/**
 * Writes a zip archive: each file stored or deflated, names in UTF-8, no folders, comments or
 * ZIP64 - so an archive holds at most 65535 files and 4 GB.
 */

import { concatBytes, crc32, pipeBytes } from "./bytes";

/** One file of an archive. */
export interface ZipEntry {
  /** Its path in the archive. */
  readonly name: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  /** Whether to deflate it - pointless for a format compressed already (PNG, JPEG, WebP). */
  readonly deflate: boolean;
}

const STORED = 0;
const DEFLATED = 8;
// Version 2.0 - the first with deflate.
const VERSION = 20;
// General purpose bit 11 - the name is UTF-8.
const UTF8_NAME = 0x0800;

/** The MS-DOS time and date fields of `date`, in local time as zip tools read them. */
function dosDateTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** The archive of `entries`, every file dated `modified`. */
export async function writeZip(
  entries: readonly ZipEntry[],
  modified: Date = new Date(),
): Promise<Uint8Array<ArrayBuffer>> {
  const stamp = dosDateTime(modified);
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const deflated = entry.deflate
      ? await pipeBytes(entry.bytes, new CompressionStream("deflate-raw"))
      : undefined;
    // Deflate can grow data it cannot shrink - then the file is stored.
    const packed =
      deflated !== undefined && deflated.length < entry.bytes.length ? deflated : undefined;
    const data = packed ?? entry.bytes;
    // The fields the local header and the central record share, from "version needed" on.
    const shared = new Uint8Array(26);
    const view = new DataView(shared.buffer);
    view.setUint16(0, VERSION, true);
    view.setUint16(2, UTF8_NAME, true);
    view.setUint16(4, packed === undefined ? STORED : DEFLATED, true);
    view.setUint16(6, stamp.time, true);
    view.setUint16(8, stamp.date, true);
    view.setUint32(10, crc32(entry.bytes), true);
    view.setUint32(14, data.length, true);
    view.setUint32(18, entry.bytes.length, true);
    view.setUint16(22, name.length, true);

    const local = concatBytes([signature(0x04034b50), shared, name, data]);
    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, VERSION, true);
    central.set(shared, 6);
    // Comment length, disk number, internal and external attributes stay zero.
    centralView.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const directory = concatBytes(centrals);
  if (entries.length > 0xffff || offset + directory.length > 0xffffffff) {
    throw new Error("writeZip: too many files or bytes for an archive without ZIP64");
  }
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, directory.length, true);
  endView.setUint32(16, offset, true);
  return concatBytes([...locals, directory, end]);
}

function signature(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}
