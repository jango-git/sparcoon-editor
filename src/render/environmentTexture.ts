/**
 * The editor's live HDRI environment cache (ADR-0004): decodes uploaded `.hdr` files into the GPU
 * textures (full-res for the SH bake, a small fixed resize for `scene.background`) and derived Sun
 * the active-environment preview needs. Mirrors {@link TextureRegistry}'s cache/dispose shape.
 */

import {
  ClampToEdgeWrapping,
  DataTexture,
  EquirectangularReflectionMapping,
  FloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  RGBAFormat,
  RepeatWrapping,
} from "three";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import type { EnvironmentAsset } from "../model/editorState";
import { deriveSunFromEquirect, type DerivedSun } from "./sunFromEnvironment";

/** Fixed background resolution (ADR-0004: "a small fixed resolution", not a tunable blur amount). */
const BACKGROUND_WIDTH = 128;
const BACKGROUND_HEIGHT = 64;

export interface DecodedEnvironment {
  /** Full-resolution decode - the sky dome's material for the SH bake. */
  readonly full: DataTexture;
  /** Small fixed-resolution resize - assigned directly to `scene.background`. */
  readonly background: DataTexture;
  /** Sun auto-derived from the brightest pixel in `background`'s upper hemisphere. */
  readonly sun: DerivedSun;
}

interface CacheEntry {
  readonly dataUrl: string;
  readonly decoded?: DecodedEnvironment;
}

export class EnvironmentTextureRegistry {
  private readonly loader = new RGBELoader().setDataType(FloatType);
  private readonly entries = new Map<string, CacheEntry>();

  /** @param onLoaded Called once an environment finishes decoding, so the preview can re-apply. */
  constructor(private readonly onLoaded: () => void) {}

  /** Reconciles the cache with the current library: add new, replace changed, drop gone. */
  public sync(assets: readonly EnvironmentAsset[]): void {
    const live = new Set(assets.map((asset) => asset.name));
    for (const [name, entry] of this.entries) {
      if (!live.has(name)) {
        disposeDecoded(entry.decoded);
        this.entries.delete(name);
      }
    }
    for (const asset of assets) {
      const existing = this.entries.get(asset.name);
      if (existing?.dataUrl !== asset.dataUrl) {
        disposeDecoded(existing?.decoded);
        this.entries.set(asset.name, { dataUrl: asset.dataUrl });
        this.load(asset.name, asset.dataUrl);
      }
    }
  }

  /** The decoded textures for an active environment name, or `undefined` while absent/decoding. */
  public resolve(name: string | undefined): DecodedEnvironment | undefined {
    return name === undefined ? undefined : this.entries.get(name)?.decoded;
  }

  public destroy(): void {
    for (const entry of this.entries.values()) {
      disposeDecoded(entry.decoded);
    }
    this.entries.clear();
  }

  private load(name: string, dataUrl: string): void {
    this.loader.load(
      dataUrl,
      (full) => {
        // The entry may have been evicted or replaced while this decode was in flight.
        const current = this.entries.get(name);
        if (current?.dataUrl !== dataUrl) {
          full.dispose();
          return;
        }
        configureFull(full);
        const downsampled = downsampleEquirect(
          sourceFromFull(full),
          BACKGROUND_WIDTH,
          BACKGROUND_HEIGHT,
        );
        const background = wrapBackgroundTexture(downsampled);
        const sun = deriveSunFromEquirect({
          data: downsampled,
          width: BACKGROUND_WIDTH,
          height: BACKGROUND_HEIGHT,
        });
        this.entries.set(name, { dataUrl, decoded: { full, background, sun } });
        this.onLoaded();
      },
      undefined,
      (error) => console.warn(`Failed to decode environment "${name}"`, error),
    );
  }
}

function disposeDecoded(decoded: DecodedEnvironment | undefined): void {
  decoded?.full.dispose();
  decoded?.background.dispose();
}

/** Float HDR data has no reliable cross-device mipmap path, so filtering stays a plain bilinear sample. */
function configureFull(texture: DataTexture): void {
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.needsUpdate = true;
}

/** `full.image`'s actual shape (typed as `unknown` by three's `Texture.image`). */
function sourceFromFull(full: DataTexture): {
  readonly data: Float32Array;
  readonly width: number;
  readonly height: number;
} {
  return full.image as unknown as { data: Float32Array; width: number; height: number };
}

/** Wraps a downsampled equirect resize as the texture assigned to `scene.background`. */
export function wrapBackgroundTexture(data: Float32Array<ArrayBuffer>): DataTexture {
  const texture = new DataTexture(data, BACKGROUND_WIDTH, BACKGROUND_HEIGHT, RGBAFormat, FloatType);
  texture.colorSpace = LinearSRGBColorSpace;
  texture.mapping = EquirectangularReflectionMapping;
  configureFull(texture);
  // RGBELoader sets this on `full`; without it here, `background` uploads vertically mirrored
  // relative to `full` (and the SH bake derived from it) under WebGL's UNPACK_FLIP_Y_WEBGL.
  texture.flipY = true;
  return texture;
}

/** Nearest-neighbor resize of an RGBA float equirect image. Point sampling (not a box/gaussian
 * average) is deliberate - ADR-0004 relies on the GPU's own magnification filter instead. */
export function downsampleEquirect(
  source: { readonly data: Float32Array; readonly width: number; readonly height: number },
  targetWidth: number,
  targetHeight: number,
): Float32Array<ArrayBuffer> {
  const target = new Float32Array(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y++) {
    const sourceY = Math.min(
      source.height - 1,
      Math.floor(((y + 0.5) / targetHeight) * source.height),
    );
    for (let x = 0; x < targetWidth; x++) {
      const sourceX = Math.min(
        source.width - 1,
        Math.floor(((x + 0.5) / targetWidth) * source.width),
      );
      const sourceIndex = (sourceY * source.width + sourceX) * 4;
      const targetIndex = (y * targetWidth + x) * 4;
      target[targetIndex] = readComponent(source.data, sourceIndex);
      target[targetIndex + 1] = readComponent(source.data, sourceIndex + 1);
      target[targetIndex + 2] = readComponent(source.data, sourceIndex + 2);
      target[targetIndex + 3] = readComponent(source.data, sourceIndex + 3);
    }
  }
  return target;
}

/** sourceIndex is derived from clamped sourceY/sourceX, so it is in bounds whenever `data`
 * genuinely holds an RGBA equirect (length === width * height * 4); guards a format mismatch. */
function readComponent(data: Float32Array, index: number): number {
  const value = data[index];
  if (value === undefined) {
    throw new Error("Equirect source data index out of bounds");
  }
  return value;
}
