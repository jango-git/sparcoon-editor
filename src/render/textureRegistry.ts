/**
 * The editor's live texture cache: turns the asset library's data-URL images into Three
 * {@link Texture} objects. The runtime never disposes an external texture, so this registry owns
 * their lifecycle; {@link resolve} falls back to a 1x1 transparent texture for a missing asset.
 */

import type { Texture } from "three";
import { DataTexture, SRGBColorSpace, TextureLoader } from "three";

import type { TextureAsset } from "../model/editorState";
import { LibraryCache } from "./libraryCache";

export class TextureRegistry {
  private readonly loader = new TextureLoader();
  // A replaced image (another data URL) is a new texture; a relabelled asset is not.
  private readonly cache = new LibraryCache<TextureAsset, Texture>(
    (asset) => this.load(asset.dataUrl),
    (texture) => texture.dispose(),
    (previous, next) => previous.dataUrl !== next.dataUrl,
  );
  /** A shared 1x1 transparent texture bound wherever an asset is missing. */
  private readonly fallback = createTransparentTexture();

  /** @param onLoaded Called once an image finishes decoding, so the preview can rebind. */
  constructor(private readonly onLoaded: () => void) {}

  public sync(assets: readonly TextureAsset[]): void {
    this.cache.sync(assets);
  }

  /** The texture for an asset name, or the shared transparent fallback if absent. */
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

/** A 1x1 fully transparent texture - the neutral stand-in for an unbound sampler slot. */
function createTransparentTexture(): Texture {
  const texture = new DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  texture.needsUpdate = true;
  return texture;
}
