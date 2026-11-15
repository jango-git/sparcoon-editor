/** Byte-level pieces the file formats the editor writes share. */

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

/** CRC-32 of `bytes`, as PNG and zip use it. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** `bytes` passed through `stream`, a compression or decompression stream. */
export async function pipeBytes(
  bytes: Uint8Array<ArrayBuffer>,
  stream: GenericTransformStream,
): Promise<Uint8Array<ArrayBuffer>> {
  const piped = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

/** `parts` one after another. */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const joined = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

/**
 * The bytes of base64 `text`.
 * @throws When `text` is not base64.
 */
export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
}

/**
 * The bytes of a base64 data URL - what the library stores a file as.
 * @throws When `dataUrl` is not a base64 data URL.
 */
export function dataUrlBytes(dataUrl: string): Uint8Array<ArrayBuffer> {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || !dataUrl.slice(0, comma).endsWith(";base64")) {
    throw new Error("dataUrlBytes: not a base64 data URL");
  }
  return base64ToBytes(dataUrl.slice(comma + 1));
}

/** `bytes` as base64 text. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  // In blocks - spreading a whole large file into one call overflows the argument limit.
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
