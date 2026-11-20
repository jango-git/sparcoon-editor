import type { BufferGeometry, Data3DTexture } from "three";

import type { LibraryAssetNames } from "../domain/assetChecks";

export interface PreviewAssets {
  readonly geometries: Readonly<Record<string, BufferGeometry>>;
  readonly volumes: Readonly<Record<string, Data3DTexture>>;
}

export const NO_PREVIEW_ASSETS: PreviewAssets = { geometries: {}, volumes: {} };

export function previewAssetNames(assets: PreviewAssets): LibraryAssetNames {
  return { mesh: Object.keys(assets.geometries), volume: Object.keys(assets.volumes) };
}
