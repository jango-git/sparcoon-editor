/**
 * The editor's live texture cache: turns the asset library's data-URL images into Three
 * {@link Texture} objects. The runtime never disposes an external texture, so this registry owns
 * their lifecycle; {@link resolve} falls back to a 1x1 transparent texture for a missing asset.
 */

import type { Texture } from "three";
import { DataTexture, SRGBColorSpace, TextureLoader } from "three";
import type { TextureAsset } from "../model/editorState";

/** One cached entry: the source data URL (to detect a changed image) and its texture. */
interface CachedTexture {
  readonly dataUrl: string;
  readonly texture: Texture;
}

export class TextureRegistry {
  private readonly loader = new TextureLoader();
  private readonly entries = new Map<string, CachedTexture>();
  /** A shared 1x1 transparent texture bound wherever an asset is missing. */
  private readonly fallback = createTransparentTexture();

  /** @param onLoaded Called once an image finishes decoding, so the preview can rebind. */
  constructor(private readonly onLoaded: () => void) {}

  /** Reconciles the cache with the current asset set: add new, replace changed, drop gone. */
  public sync(assets: readonly TextureAsset[]): void {
    const live = new Set(assets.map((asset) => asset.name));
    for (const [name, entry] of this.entries) {
      if (!live.has(name)) {
        entry.texture.dispose();
        this.entries.delete(name);
      }
    }
    for (const asset of assets) {
      const existing = this.entries.get(asset.name);
      if (existing?.dataUrl !== asset.dataUrl) {
        existing?.texture.dispose();
        this.entries.set(asset.name, { dataUrl: asset.dataUrl, texture: this.load(asset.dataUrl) });
      }
    }
  }

  /** The texture for an asset name, or the shared transparent fallback if absent. */
  public resolve(name: string): Texture {
    return this.entries.get(name)?.texture ?? this.fallback;
  }

  public destroy(): void {
    for (const entry of this.entries.values()) {
      entry.texture.dispose();
    }
    this.entries.clear();
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
