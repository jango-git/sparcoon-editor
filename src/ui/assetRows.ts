/** Renders one asset library's rows (image/HDRI/mesh/volume), normalized to a single {@link AssetRow} shape. */

import { t } from "../i18n";
import {
  removeEnvironmentAsset,
  removeMeshAsset,
  removeTextureAsset,
  removeVolumeAsset,
} from "../model/commands";
import type { EnvironmentAsset, MeshAsset, TextureAsset, VolumeAsset } from "../model/editorState";
import {
  selectAssetUsage,
  selectEnvironmentAssets,
  selectMeshAssets,
  selectTextureAssets,
  selectVolumeAssets,
} from "../model/selectors";
import type { Store } from "../model/store";
import { environmentThumbnails, meshThumbnails } from "../render/assetThumbnails";
import { type AssetFile, meshFile, uploadedFile, volumeFile } from "./assetFiles";
import { attachCountdownConfirm } from "./components/countdownConfirm";
import { attachTooltip } from "./components/tooltip";
import { createElement } from "./dom";
import { downloadFile } from "./download";
import { actionIcons, assetIcons, icon } from "./icons";

/** Presses to confirm a delete in the content sheet (see {@link attachCountdownConfirm}). */
const DELETE_CLICKS = 4;

/** A row's own action beside its download, an icon button. */
export interface AssetRowAction {
  readonly glyph: string;
  readonly title: string;
  readonly description: string;
  run(): void;
}

/** The uniform shape a row renders from, normalized across the asset kinds. */
export interface AssetRow {
  readonly name: string;
  readonly label: string;
  readonly users: number;
  /** Overrides the default "Used by {count} node(s)" tooltip body - an HDRI's count means "is the
   *  active viewport environment" (0 or 1), not a node-reference tally. */
  readonly usersTooltip?: string;
  /** A rendered preview image. Present for image assets (the source itself) and mesh assets
   *  (rendered inline) immediately; for HDRI assets only once the async decode lands - absent
   *  until then, so the row falls back to the kind glyph for that one render. */
  readonly thumbnailUrl?: string;
  /** Kind glyph used as the preview when there is no thumbnail. */
  readonly glyph: string;
  /** Extra info line under the file name in the title's tooltip (dimensions or byte size). */
  readonly detail: string;
  /** Actions of its kind, before the download. */
  readonly actions?: readonly AssetRowAction[];
  download(): void;
  remove(): void;
}

/** Replaces a column's rows, showing the empty hint when the library holds nothing. */
export function fillColumn(list: HTMLElement, emptyHint: string, rows: readonly AssetRow[]): void {
  if (rows.length === 0) {
    list.replaceChildren(
      createElement("div", { className: "content-group__empty", textContent: emptyHint }),
    );
    return;
  }
  list.replaceChildren(...rows.map(assetRowElement));
}

export function textureRows(store: Store, usage: ReadonlyMap<string, number>): readonly AssetRow[] {
  return selectTextureAssets(store).map((asset: TextureAsset) => ({
    name: asset.name,
    label: asset.label,
    users: usage.get(asset.name) ?? 0,
    thumbnailUrl: asset.dataUrl,
    glyph: assetIcons.image,
    detail: t("content.imageSize", { width: String(asset.width), height: String(asset.height) }),
    download: () => save(uploadedFile(asset)),
    remove: () => removeTextureAsset(store, asset.name),
  }));
}

/**
 * `users` is 1 when the HDRI is the document's active environment, otherwise 0.
 * @param onThumbnailReady Called once a still-decoding HDRI's thumbnail lands, so the caller can
 *   re-list and pick it up from the cache.
 */
export function environmentRows(store: Store, onThumbnailReady: () => void): readonly AssetRow[] {
  const assets = selectEnvironmentAssets(store);
  const thumbnails = environmentThumbnails(assets, onThumbnailReady);
  const activeEnvironmentName = store.getSource().activeEnvironmentName;
  return assets.map((asset: EnvironmentAsset) => {
    const active = asset.name === activeEnvironmentName;
    const thumbnailUrl = thumbnails.get(asset.name);
    return {
      name: asset.name,
      label: asset.label,
      users: active ? 1 : 0,
      usersTooltip: active
        ? t("content.environmentActiveTip")
        : t("content.environmentInactiveTip"),
      ...(thumbnailUrl !== undefined ? { thumbnailUrl } : {}),
      glyph: assetIcons.hdri,
      detail: formatBytes(asset.byteSize),
      download: () => save(uploadedFile(asset)),
      remove: (): void => removeEnvironmentAsset(store, asset.name),
    };
  });
}

/** `onBake` opens the SDF baker on a mesh. */
export function meshRows(store: Store, onBake: (mesh: MeshAsset) => void): readonly AssetRow[] {
  const assets = selectMeshAssets(store);
  const thumbnails = meshThumbnails(assets);
  const usage = selectAssetUsage(store, "mesh");
  return assets.map((asset: MeshAsset) => {
    const thumbnailUrl = thumbnails.get(asset.name);
    return {
      name: asset.name,
      label: asset.label,
      users: usage.get(asset.name) ?? 0,
      ...(thumbnailUrl !== undefined ? { thumbnailUrl } : {}),
      glyph: assetIcons.mesh,
      detail: formatBytes(asset.byteSize),
      actions: [
        {
          glyph: assetIcons.bakeVolume,
          title: t("content.bakeVolume"),
          description: t("content.bakeVolumeTip"),
          run: () => onBake(asset),
        },
      ],
      download: () => save(meshFile(asset)),
      remove: () => removeMeshAsset(store, asset.name),
    };
  });
}

/** The volume rows - the slice atlas as the preview, downloaded as is. */
export function volumeRows(store: Store): readonly AssetRow[] {
  const usage = selectAssetUsage(store, "volume");
  return selectVolumeAssets(store).map((asset: VolumeAsset) => {
    const size = asset.size.join("x");
    return {
      name: asset.name,
      label: asset.label,
      users: usage.get(asset.name) ?? 0,
      ...(asset.dataUrl === "" ? {} : { thumbnailUrl: asset.dataUrl }),
      glyph: assetIcons.volume,
      detail: t("content.volumeSize", { size }),
      download: () => save(volumeFile(asset)),
      remove: () => removeVolumeAsset(store, asset.name),
    };
  });
}

/** One library row: preview, name, a flexible gap, the user count, then download and delete. */
function assetRowElement(row: AssetRow): HTMLElement {
  const preview = createElement("div", { className: "asset-row__preview" });
  if (row.thumbnailUrl !== undefined) {
    const thumbnail = document.createElement("img");
    thumbnail.className = "asset-row__thumb";
    thumbnail.src = row.thumbnailUrl;
    thumbnail.alt = row.label;
    thumbnail.draggable = false;
    preview.append(thumbnail);
  } else {
    preview.append(icon(row.glyph));
  }

  const name = createElement("span", { className: "asset-row__title", textContent: row.label });
  attachTooltip(name, row.label, row.detail);

  const count = createElement("span", {
    className: "asset-row__count",
    textContent: String(row.users),
  });
  attachTooltip(
    count,
    t("content.usersTitle"),
    row.usersTooltip ?? t("content.usersTip", { count: String(row.users) }),
  );

  const actions = [
    ...(row.actions ?? []),
    {
      glyph: assetIcons.download,
      title: t("content.download"),
      description: t("content.downloadTip"),
      run: (): void => row.download(),
    },
  ].map((action) => {
    const button = createElement("button", { className: "asset-row__action", type: "button" });
    button.append(icon(action.glyph));
    attachTooltip(button, action.title, action.description);
    button.addEventListener("click", () => action.run());
    return button;
  });

  // Delete is guarded by the shared countdown-confirm control (four clicks): a stray click never
  // drops an asset, and the button counts down and reverts to the trash glyph if left idle.
  const remove = createElement("button", {
    className: "asset-row__remove confirm-danger",
    type: "button",
  });
  remove.innerHTML = actionIcons.trash;
  attachTooltip(remove, t("content.deleteAsset"), t("content.deleteAssetTip"));
  attachCountdownConfirm(remove, actionIcons.trash, DELETE_CLICKS, row.remove);

  return createElement("div", { className: "asset-row" }, [
    preview,
    name,
    createElement("div", { className: "asset-row__spacer" }),
    count,
    ...actions,
    remove,
  ]);
}

/** Downloads an asset's file - a mesh's once its GLB is written. */
function save(file: AssetFile | Promise<AssetFile>): void {
  void Promise.resolve(file).then(({ fileName, bytes }) => downloadFile(fileName, bytes));
}

/** A compact byte-size label (e.g. "12.3 KB"); binary units, one decimal past kilobytes. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex] ?? "KB"}`;
}
