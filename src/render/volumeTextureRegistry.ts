/**
 * The editor's live volume cache: turns the library's PNG atlas data URLs into R8 `Data3DTexture`s,
 * the form the runtime takes them in. Decoding is asynchronous, so until it lands an asset resolves
 * to a one-texel stand-in, and the preview rebuilds once the real texture is in.
 */

import { Data3DTexture, RedFormat, UnsignedByteType } from "three";

import { volumeFromAtlasDataUrl } from "../domain/volumeAtlas";
import type { VolumeAsset } from "../model/editorState";
import { LibraryCache } from "./libraryCache";

/** An asset's texture: the stand-in, then the decoded one. Disposed once replaced or gone. */
interface VolumeSlot {
  texture: Data3DTexture;
  disposed: boolean;
}

/** An R8 texture of `texels`. */
function r8Texture(
  texels: Uint8Array<ArrayBuffer>,
  width: number,
  height: number,
  depth: number,
): Data3DTexture {
  const texture = new Data3DTexture(texels, width, height, depth);
  texture.format = RedFormat;
  texture.type = UnsignedByteType;
  return texture;
}

export class VolumeTextureRegistry {
  private readonly cache = new LibraryCache<VolumeAsset, VolumeSlot>(
    (asset) => this.load(asset),
    (slot) => {
      slot.disposed = true;
      slot.texture.dispose();
    },
  );

  /** @param onLoaded Called once a volume finishes decoding, so the preview can rebuild. */
  constructor(private readonly onLoaded: () => void) {}

  public sync(assets: readonly VolumeAsset[]): void {
    this.cache.sync(assets);
  }

  /** Every volume asset's texture, by name - the stand-in while it decodes. */
  public resolveAll(): Record<string, Data3DTexture> {
    return Object.fromEntries(
      Object.entries(this.cache.all()).map(([name, slot]) => [name, slot.texture]),
    );
  }

  public destroy(): void {
    this.cache.destroy();
  }

  private load(asset: VolumeAsset): VolumeSlot {
    // A stand-in far from any surface - its texel is the largest distance the bake encodes.
    const slot: VolumeSlot = {
      texture: r8Texture(new Uint8Array([255]), 1, 1, 1),
      disposed: false,
    };
    // The payload is still on its way from the blob store - the filled-in asset loads anew.
    if (asset.dataUrl === "") {
      return slot;
    }
    const [width, height, depth] = asset.size;
    volumeFromAtlasDataUrl(asset.dataUrl, asset.size)
      .then((texels) => {
        if (slot.disposed) {
          return;
        }
        slot.texture.dispose();
        slot.texture = r8Texture(texels, width, height, depth);
        this.onLoaded();
      })
      .catch((error: unknown) => {
        console.warn(`VolumeTextureRegistry: volume "${asset.name}" could not be decoded`, error);
      });
    return slot;
  }
}
