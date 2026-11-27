/** The content library's assets of one kind as picker options, with their previews. */

import type { FXAssetKind } from "../engine/core/nodes/FXAssetKind";
import { kindAssets } from "../model/selectors";
import type { Store } from "../model/store";
import { meshThumbnails } from "../render/assetThumbnails";
import type { AssetPickerOption } from "./components/assetPicker";

/** The library's assets of `kind`, in library order - a mesh with its rendered thumbnail, a volume
 *  with its slice atlas. */
export function libraryAssetOptions(store: Store, kind: FXAssetKind): AssetPickerOption[] {
  const found = kindAssets(store.getSource(), kind);
  if (found.library === "volume") {
    return found.assets.map((asset) => ({
      name: asset.name,
      label: asset.label,
      ...(asset.dataUrl === "" ? {} : { thumbnailUrl: asset.dataUrl }),
    }));
  }
  const thumbnails = meshThumbnails(found.assets);
  return found.assets.map((asset) => {
    const thumbnailUrl = thumbnails.get(asset.name);
    return {
      name: asset.name,
      label: asset.label,
      ...(thumbnailUrl === undefined ? {} : { thumbnailUrl }),
    };
  });
}
