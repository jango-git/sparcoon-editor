/**
 * The scene library's GLB files as object trees for the preview, by asset name. Every mesh of a
 * scene casts and receives the sun's shadows.
 */

import { type Material, Mesh, type Object3D, Texture } from "three";

import type { SceneAsset } from "../model/editorState";
import { createGltfLoader } from "./gltfLoader";
import { AsyncLibraryCache } from "./libraryCache";

export class SceneAssetRegistry {
  private readonly loader = createGltfLoader();
  private readonly cache: AsyncLibraryCache<SceneAsset, Object3D>;

  constructor(onLoaded: () => void) {
    this.cache = new AsyncLibraryCache(
      (asset) => this.decode(asset),
      disposeTree,
      (previous, next) => previous.bytes !== next.bytes,
      onLoaded,
    );
  }

  public sync(assets: readonly SceneAsset[]): void {
    this.cache.sync(assets);
  }

  /** The decoded scene, or `undefined` while it decodes or when it failed to. */
  public resolve(name: string): Object3D | undefined {
    return this.cache.get(name);
  }

  public destroy(): void {
    this.cache.destroy();
  }

  private async decode(asset: SceneAsset): Promise<Object3D | undefined> {
    if (asset.bytes.length === 0) {
      return undefined;
    }
    try {
      const root = (await this.loader.parseAsync(asset.bytes.slice().buffer, "")).scene;
      root.traverse((object) => {
        if (object instanceof Mesh) {
          object.castShadow = true;
          object.receiveShadow = true;
        }
      });
      return root;
    } catch (error) {
      console.warn(`Failed to decode scene "${asset.name}"`, error);
      return undefined;
    }
  }
}

/** Frees the geometries, materials and textures of `root`'s meshes. */
function disposeTree(root: Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof Mesh)) {
      return;
    }
    object.geometry.dispose();
    const materials: Material[] = Array.isArray(object.material)
      ? object.material
      : [object.material];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof Texture) {
          value.dispose();
        }
      }
      material.dispose();
    }
  });
}
