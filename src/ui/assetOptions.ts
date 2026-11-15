/** The content library's assets of one kind as picker options, with their previews. */

import type { FXAssetKind } from "../engine/core/nodes/FXAssetKind";
import { selectMeshAssets, selectVolumeAssets } from "../model/selectors";
import type { Store } from "../model/store";
import { meshThumbnails } from "../render/assetThumbnails";
import type { AssetPickerOption } from "./components/assetPicker";

/** The library's assets of `kind`, in library order - a mesh with its rendered thumbnail, a volume
 *  with its slice atlas. */
export function libraryAssetOptions(store: Store, kind: FXAssetKind): AssetPickerOption[] {
  if (kind === "volume") {
    return selectVolumeAssets(store).map((asset) => ({
      name: asset.name,
      label: asset.label,
      ...(asset.dataUrl === "" ? {} : { thumbnailUrl: asset.dataUrl }),
    }));
  }
  const assets = selectMeshAssets(store);
  const thumbnails = meshThumbnails(assets);
  return assets.map((asset) => {
    const thumbnailUrl = thumbnails.get(asset.name);
    return {
      name: asset.name,
      label: asset.label,
      ...(thumbnailUrl === undefined ? {} : { thumbnailUrl }),
    };
  });
}
