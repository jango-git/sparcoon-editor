/**
 * Turns data-URL images into Three textures. Owns their disposal, as the runtime never disposes
 * external textures. `resolve` falls back to a 1x1 transparent texture.
 */

import type { Texture } from "three";
import { DataTexture, SRGBColorSpace, TextureLoader } from "three";

import type { TextureAsset } from "../model/editorState";
import { LibraryCache } from "./libraryCache";

export class TextureRegistry {
  private readonly loader = new TextureLoader();
  private readonly cache = new LibraryCache<TextureAsset, Texture>(
    (asset) => this.load(asset.dataUrl),
    (texture) => texture.dispose(),
    (previous, next) => previous.dataUrl !== next.dataUrl,
  );
  private readonly fallback = createTransparentTexture();

  constructor(private readonly onLoaded: () => void) {}

  public sync(assets: readonly TextureAsset[]): void {
    this.cache.sync(assets);
  }

  public resolve(name: string): Texture {
    return this.cache.get(name) ?? this.fallback;
  }

  public destroy(): void {
    this.cache.destroy();
    this.fallback.dispose();
  }

  private load(dataUrl: string): Texture {
    const texture = this.loader.load(dataUrl, () => this.onLoaded());
    // Particle albedo is authored in sRGB, so the sampler must decode to linear on read.
    texture.colorSpace = SRGBColorSpace;
    return texture;
  }
}

function createTransparentTexture(): Texture {
  const texture = new DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  texture.needsUpdate = true;
  return texture;
}
