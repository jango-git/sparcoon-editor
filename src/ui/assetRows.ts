/** Renders one asset library's rows (image/HDRI/mesh), normalized to a single {@link AssetRow} shape. */

import { Mesh } from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { t } from "../i18n";
import { removeEnvironmentAsset, removeMeshAsset, removeTextureAsset } from "../model/commands";
import type { EnvironmentAsset, MeshAsset, TextureAsset } from "../model/editorState";
import { deleteEnvironmentBlob } from "../persistence/environmentBlobStore";
import { environmentThumbnails, meshThumbnails } from "../render/assetThumbnails";
import { buildGeometryFromArrays } from "../render/meshGeometryBaking";
import { selectEnvironmentAssets, selectMeshAssets, selectTextureAssets } from "../model/selectors";
import type { Store } from "../model/store";
import { attachCountdownConfirm } from "./components/countdownConfirm";
import { attachTooltip } from "./components/tooltip";
import { createElement } from "./dom";
import { actionIcons, assetIcons, icon } from "./icons";

/** Presses to confirm a delete in the content sheet (see {@link attachCountdownConfirm}). */
const DELETE_CLICKS = 4;

/** The uniform shape a row renders from, normalized across the three asset kinds. */
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
    download: () => downloadDataUrl(asset.label, asset.dataUrl),
    remove: () => removeTextureAsset(store, asset.name),
  }));
}

/**
 * `users` is unlike a texture's node-reference count: an HDRI's "usage" is just whether it is the
 * document's one active environment (ADR-0004), so it's always 0 or 1.
 * @param onThumbnailReady A still-decoding HDRI has no thumbnail yet (RGBE decode is async); called
 * once one lands so the caller can re-list and pick it up from the cache.
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
      download: () => downloadDataUrl(asset.label, asset.dataUrl),
      remove: (): void => {
        removeEnvironmentAsset(store, asset.name);
        void deleteEnvironmentBlob(asset.name);
      },
    };
  });
}

export function meshRows(store: Store): readonly AssetRow[] {
  const assets = selectMeshAssets(store);
  const thumbnails = meshThumbnails(assets);
  return assets.map((asset: MeshAsset) => {
    const thumbnailUrl = thumbnails.get(asset.name);
    return {
      name: asset.name,
      label: asset.label,
      users: 0,
      ...(thumbnailUrl !== undefined ? { thumbnailUrl } : {}),
      glyph: assetIcons.mesh,
      detail: formatBytes(asset.byteSize),
      download: () => void downloadMeshAsset(asset),
      remove: () => removeMeshAsset(store, asset.name),
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

  const download = createElement("button", { className: "asset-row__action", type: "button" });
  download.append(icon(assetIcons.download));
  attachTooltip(download, t("content.download"), t("content.downloadTip"));
  download.addEventListener("click", () => row.download());

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
    download,
    remove,
  ]);
}

/** Triggers a browser download of the asset's original file from its data URL. */
function downloadDataUrl(fileName: string, dataUrl: string): void {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = fileName;
  link.click();
}

/**
 * Regenerates a single-mesh GLB from a mesh asset's baked geometry (ADR-0001 - the original upload
 * bytes are not retained) and triggers its download.
 */
async function downloadMeshAsset(asset: MeshAsset): Promise<void> {
  const geometry = buildGeometryFromArrays(asset.geometry);
  try {
    const glb = await new GLTFExporter().parseAsync(new Mesh(geometry), { binary: true });
    const blob = new Blob([glb as ArrayBuffer], { type: "model/gltf-binary" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${asset.label}.glb`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } finally {
    geometry.dispose();
  }
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
