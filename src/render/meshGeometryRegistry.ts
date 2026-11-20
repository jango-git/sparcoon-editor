/** Turns baked mesh-asset arrays into `BufferGeometry`, synchronously. */

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

  public resolveAll(): Record<string, BufferGeometry> {
    return this.cache.all();
  }

  public destroy(): void {
    this.cache.destroy();
  }
}
