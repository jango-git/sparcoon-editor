import type { FXAppAssets } from "sparcoon/editor";

import type { LibraryAssetNames } from "../domain/assetChecks";
import { FX_ASSET_KINDS, mapAssetKinds } from "../engine/core/nodes/FXAssetKind";

/** The assets the preview hands an emitter, as the runtime takes them. */
export type PreviewAssets = Readonly<FXAppAssets>;

export const NO_PREVIEW_ASSETS: PreviewAssets = { geometries: {}, meshes: {}, volumes: {} };

/** The names of the assets of each kind `assets` holds. */
export function previewAssetNames(assets: PreviewAssets): LibraryAssetNames {
  return mapAssetKinds((kind) => {
    const { appField, appAccepts } = FX_ASSET_KINDS[kind];
    return Object.entries(assets[appField])
      .filter(([, asset]) => appAccepts(asset))
      .map(([name]) => name);
  });
}
