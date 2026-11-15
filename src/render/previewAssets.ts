import type { BufferGeometry, Data3DTexture } from "three";

import type { LibraryAssetNames } from "../domain/assetChecks";

/** The content library's assets the preview hands the runtime, live, by name. */
export interface PreviewAssets {
  /** Mesh assets - what a "custom" geometry source draws and a mesh surface samples. */
  readonly geometries: Readonly<Record<string, BufferGeometry>>;
  /** Volume assets - the 3D textures a behavior samples. */
  readonly volumes: Readonly<Record<string, Data3DTexture>>;
}

/** No assets. */
export const NO_PREVIEW_ASSETS: PreviewAssets = { geometries: {}, volumes: {} };

/** The names of `assets`, by kind. */
export function previewAssetNames(assets: PreviewAssets): LibraryAssetNames {
  return { mesh: Object.keys(assets.geometries), volume: Object.keys(assets.volumes) };
}
