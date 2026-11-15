/**
 * The editor's live mesh-geometry cache: turns baked mesh-asset arrays into `BufferGeometry`
 * objects. Unlike {@link TextureRegistry}, fully synchronous - no image decode to await.
 */

import type { BufferGeometry } from "three";

import type { MeshAsset } from "../model/editorState";
import { LibraryCache } from "./libraryCache";
import { buildGeometryFromArrays } from "./meshGeometryBaking";

export class MeshGeometryRegistry {
  private readonly cache = new LibraryCache<MeshAsset, BufferGeometry>(
    (asset) => buildGeometryFromArrays(asset.geometry),
    (geometry) => geometry.dispose(),
    (previous, next) => previous.geometry !== next.geometry,
  );

  public sync(assets: readonly MeshAsset[]): void {
    this.cache.sync(assets);
  }

  /** Every cached mesh asset's live geometry, by name - the shape `resolveGeometrySource` expects. */
  public resolveAll(): Record<string, BufferGeometry> {
    return this.cache.all();
  }

  public destroy(): void {
    this.cache.destroy();
  }
}
