/**
 * Turns PNG atlas data URLs into R8 `Data3DTexture`s. Until decoding finishes an asset resolves to
 * a one-texel stand-in.
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

  constructor(private readonly onLoaded: () => void) {}

  public sync(assets: readonly VolumeAsset[]): void {
    this.cache.sync(assets);
  }

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
