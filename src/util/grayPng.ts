/**
 * Encodes and decodes 8-bit grayscale PNG images, byte for byte - no color management or alpha
 * premultiplication stands between the bytes and the file, as it does through a canvas.
 */

import { concatBytes, crc32, pipeBytes } from "./bytes";

/** An 8-bit grayscale image, row by row from the top. */
export interface GrayImage {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array<ArrayBuffer>;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const COLOR_TYPE_GRAY = 0;
const FILTER_SUB = 1;

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** `image` as a PNG file. */
export async function encodeGrayPng(image: GrayImage): Promise<Uint8Array<ArrayBuffer>> {
  const { width, height, pixels } = image;
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = COLOR_TYPE_GRAY;
  // Each row predicted from the pixel to its left - smooth images compress far better.
  const filtered = new Uint8Array(height * (width + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (width + 1);
    filtered[row] = FILTER_SUB;
    for (let x = 0; x < width; x++) {
      const at = y * width + x;
      const left = x === 0 ? 0 : (pixels[at - 1] as number);
      filtered[row + 1 + x] = ((pixels[at] as number) - left) & 0xff;
    }
  }
  const compressed = await pipeBytes(filtered, new CompressionStream("deflate"));
  return concatBytes([
    Uint8Array.from(SIGNATURE),
    chunk("IHDR", header),
    chunk("IDAT", compressed),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** The Paeth predictor of PNG filter type 4. */
function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) {
    return left;
  }
  return toUp <= toUpLeft ? up : upLeft;
}

/**
 * The image of a PNG file holding an 8-bit grayscale, non-interlaced image.
 * @throws When `file` is not such a PNG.
 */
export async function decodeGrayPng(file: Uint8Array): Promise<GrayImage> {
  if (SIGNATURE.some((byte, i) => file[i] !== byte)) {
    throw new Error("decodeGrayPng: not a PNG file");
  }
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let width = 0;
  let height = 0;
  const data: Uint8Array[] = [];
  for (let offset = SIGNATURE.length; offset + 8 <= file.length;) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...file.subarray(offset + 4, offset + 8));
    const body = file.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      if (body[8] !== 8 || body[9] !== COLOR_TYPE_GRAY || body[12] !== 0) {
        throw new Error("decodeGrayPng: not an 8-bit grayscale, non-interlaced PNG");
      }
    } else if (type === "IDAT") {
      data.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const filtered = await pipeBytes(concatBytes(data), new DecompressionStream("deflate"));
  if (width === 0 || height === 0 || filtered.length !== height * (width + 1)) {
    throw new Error("decodeGrayPng: the image data does not match its size");
  }
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const filter = filtered[y * (width + 1)];
    for (let x = 0; x < width; x++) {
      const at = y * width + x;
      const left = x === 0 ? 0 : (pixels[at - 1] as number);
      const up = y === 0 ? 0 : (pixels[at - width] as number);
      const upLeft = x === 0 || y === 0 ? 0 : (pixels[at - width - 1] as number);
      const raw = filtered[y * (width + 1) + 1 + x] as number;
      const predicted =
        filter === 1
          ? left
          : filter === 2
            ? up
            : filter === 3
              ? (left + up) >> 1
              : filter === 4
                ? paeth(left, up, upLeft)
                : 0;
      pixels[at] = (raw + predicted) & 0xff;
    }
  }
  return { width, height, pixels };
}
