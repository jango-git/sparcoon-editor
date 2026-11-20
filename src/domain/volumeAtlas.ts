/**
 * A volume's texels as one grayscale PNG atlas of its slices - how a volume asset is stored in the
 * project and downloaded. Slice `z` is the tile at column `z % columns`, row `floor(z / columns)`,
 * `columns` being `ceil(sqrt(depth))`. Within a tile, texel `(x, y)` is the pixel `x` from the left
 * and `y` from the top. Tiles past the last slice are black.
 */

import { bytesToBase64, dataUrlBytes } from "../util/bytes";
import { decodeGrayPng, encodeGrayPng, type GrayImage } from "../util/grayPng";

/** A volume's size in texels - width, height, depth. */
export type VolumeSize = readonly [number, number, number];

/** A volume's R8 texels, x varying fastest, then y, then z - a `Data3DTexture`'s `image.data`. */
export interface VolumeTexels {
  readonly size: VolumeSize;
  readonly texels: Uint8Array<ArrayBuffer>;
}

/** How a volume of `size` tiles its atlas. */
export function atlasLayout(size: VolumeSize): {
  readonly columns: number;
  readonly rows: number;
  readonly width: number;
  readonly height: number;
} {
  const [width, height, depth] = size;
  const columns = Math.ceil(Math.sqrt(depth));
  const rows = Math.ceil(depth / columns);
  return { columns, rows, width: columns * width, height: rows * height };
}

export function volumeToAtlas(volume: VolumeTexels): GrayImage {
  const [width, height, depth] = volume.size;
  const layout = atlasLayout(volume.size);
  const pixels = new Uint8Array(layout.width * layout.height);
  for (let z = 0; z < depth; z++) {
    const left = (z % layout.columns) * width;
    const top = Math.floor(z / layout.columns) * height;
    for (let y = 0; y < height; y++) {
      const from = (z * height + y) * width;
      pixels.set(volume.texels.subarray(from, from + width), (top + y) * layout.width + left);
    }
  }
  return { width: layout.width, height: layout.height, pixels };
}

/**
 * The texels of a volume of `size` from its atlas `image`.
 * @throws When the image is not the atlas of a volume of that size.
 */
export function atlasToVolume(image: GrayImage, size: VolumeSize): Uint8Array<ArrayBuffer> {
  const [width, height, depth] = size;
  const layout = atlasLayout(size);
  if (image.width !== layout.width || image.height !== layout.height) {
    throw new Error(
      `volumeAtlas: a ${String(image.width)}x${String(image.height)} image is not the atlas of a ` +
        `${size.join("x")} volume`,
    );
  }
  const texels = new Uint8Array(width * height * depth);
  for (let z = 0; z < depth; z++) {
    const left = (z % layout.columns) * width;
    const top = Math.floor(z / layout.columns) * height;
    for (let y = 0; y < height; y++) {
      const from = (top + y) * layout.width + left;
      texels.set(image.pixels.subarray(from, from + width), (z * height + y) * width);
    }
  }
  return texels;
}

const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

export async function volumeAtlasDataUrl(volume: VolumeTexels): Promise<string> {
  return PNG_DATA_URL_PREFIX + bytesToBase64(await encodeGrayPng(volumeToAtlas(volume)));
}

/**
 * The texels of a volume of `size` from its PNG atlas data URL.
 * @throws When the data URL is not such an atlas.
 */
export async function volumeFromAtlasDataUrl(
  dataUrl: string,
  size: VolumeSize,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
    throw new Error("volumeAtlas: not a PNG data URL");
  }
  return atlasToVolume(await decodeGrayPng(dataUrlBytes(dataUrl)), size);
}
