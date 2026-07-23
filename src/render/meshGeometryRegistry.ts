/**
 * The editor's live mesh-geometry cache: turns baked mesh-asset arrays into `BufferGeometry`
 * objects. Unlike {@link TextureRegistry}, fully synchronous - no image decode to await.
 */

import type { BufferGeometry } from "three";
import type { MeshAsset } from "../model/editorState";
import { buildGeometryFromArrays } from "./meshGeometryBaking";

/** One cached entry: the source baked geometry (to detect a changed asset) and its live geometry. */
interface CachedGeometry {
  readonly baked: MeshAsset["geometry"];
  readonly geometry: BufferGeometry;
}

export class MeshGeometryRegistry {
  private readonly entries = new Map<string, CachedGeometry>();

  /** Reconciles the cache with the current asset set: add new, replace changed, drop gone. */
  public sync(assets: readonly MeshAsset[]): void {
    const live = new Set(assets.map((asset) => asset.name));
    for (const [name, entry] of this.entries) {
      if (!live.has(name)) {
        entry.geometry.dispose();
        this.entries.delete(name);
      }
    }
    for (const asset of assets) {
      const existing = this.entries.get(asset.name);
      if (existing?.baked !== asset.geometry) {
        existing?.geometry.dispose();
        this.entries.set(asset.name, {
          baked: asset.geometry,
          geometry: buildGeometryFromArrays(asset.geometry),
        });
      }
    }
  }

  /** Every cached mesh asset's live geometry, by name - the shape `resolveGeometrySource` expects. */
  public resolveAll(): Record<string, BufferGeometry> {
    const geometries: Record<string, BufferGeometry> = {};
    for (const [name, entry] of this.entries) {
      geometries[name] = entry.geometry;
    }
    return geometries;
  }

  public destroy(): void {
    for (const entry of this.entries.values()) {
      entry.geometry.dispose();
    }
    this.entries.clear();
  }
}
