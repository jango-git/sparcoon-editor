/** Renders one asset library's rows (image/HDRI/scene/mesh/volume), normalized to a single {@link AssetRow} shape. */

import { t } from "../i18n";
import {
  removeEnvironmentAsset,
  removeMeshAsset,
  removeSceneAsset,
  removeTextureAsset,
  removeVolumeAsset,
  setMeshAssetPreview,
} from "../model/commands";
import {
  type EnvironmentAsset,
  type MeshAsset,
  previewClipOf,
  STUDIO_SCENE_NAME,
  type TextureAsset,
  type VolumeAsset,
} from "../model/editorState";
import {
  selectAssetUsage,
  selectEnvironmentAssets,
  selectMeshAssets,
  selectSceneAssets,
  selectTextureAssets,
  selectVolumeAssets,
} from "../model/selectors";
import type { Store } from "../model/store";
import { environmentThumbnails, meshThumbnails } from "../render/assetThumbnails";
import { type AssetFile, imageFile, meshFile, uploadedFile, volumeFile } from "./assetFiles";
import { attachCountdownConfirm } from "./components/countdownConfirm";
import { Dropdown, type DropdownOption } from "./components/dropdown";
import { createToggleButton } from "./components/toggleButton";
import { attachTooltip } from "./components/tooltip";
import { createElement } from "./dom";
import { downloadFile } from "./download";
import { actionIcons, assetIcons, icon } from "./icons";

/** Presses to confirm a delete in the content sheet (see {@link attachCountdownConfirm}). */
const DELETE_CLICKS = 4;

/** What every control of a row carries: its tooltip. */
interface AssetRowControlText {
  readonly title: string;
  readonly description: string;
}

/**
 * A control of a row's second line, before its download and delete: an icon button, an icon toggle,
 * a choice among named options, or a guarded button (pressed `clicks` times, labelled when it has
 * a `label`).
 */
export type AssetRowControl = AssetRowControlText &
  (
    | { readonly kind: "button"; readonly glyph: string; run(): void }
    | {
        readonly kind: "toggle";
        readonly glyph: string;
        readonly activeGlyph: string;
        readonly value: boolean;
        onChange(on: boolean): void;
      }
    | {
        readonly kind: "choice";
        readonly options: readonly DropdownOption[];
        readonly value: string;
        onChange(value: string): void;
      }
    | {
        readonly kind: "confirm";
        readonly glyph: string;
        readonly label?: string;
        readonly clicks: number;
        run(): void;
      }
  );

/** The uniform shape a row renders from, normalized across the asset kinds. */
export interface AssetRow {
  readonly label: string;
  /** How many use it, shown as a count; absent for a row with no users to count. */
  readonly users?: number;
  /** Overrides the default "Used by {count} node(s)" tooltip body - an HDRI's or a scene's count
   *  means "is the active one" (0 or 1), not a node-reference tally. */
  readonly usersTooltip?: string;
  /** A rendered preview image. Present for image assets (the source itself) and mesh assets
   *  (rendered inline) immediately; for HDRI assets only once the async decode lands - absent
   *  until then, so the row falls back to the kind glyph for that one render. */
  readonly thumbnailUrl?: string;
  /** Kind glyph used as the preview when there is no thumbnail. */
  readonly glyph: string;
  /** Dimensions or byte size, shown with the name in its tooltip. A row without it has no tooltip
   *  on its name. */
  readonly detail?: string;
  /** Lays the row out on two lines, the controls of its kind on the second - for a row whose
   *  settings would crowd one line. */
  readonly twoLines?: true;
  /** A class of its own beside `asset-row`, for a row set apart from the library's. */
  readonly className?: string;
  /** Settings and actions of its kind. */
  readonly controls?: readonly AssetRowControl[];
  /** Absent for a built-in entry, which has no file and cannot be deleted. */
  readonly download?: () => void;
  readonly remove?: () => void;
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
    label: asset.label,
    users: usage.get(asset.name) ?? 0,
    thumbnailUrl: asset.dataUrl,
    glyph: assetIcons.image,
    detail: t("content.imageSize", { width: String(asset.width), height: String(asset.height) }),
    download: () => save(imageFile(asset)),
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

/** The built-in scene, then the uploaded ones. `users` is 1 for the document's active scene. */
export function sceneRows(store: Store): readonly AssetRow[] {
  const activeSceneName = store.getSource().activeSceneName;
  const activity = (name: string): Pick<AssetRow, "users" | "usersTooltip"> =>
    name === activeSceneName
      ? { users: 1, usersTooltip: t("content.sceneActiveTip") }
      : { users: 0, usersTooltip: t("content.sceneInactiveTip") };
  const builtIn = (name: string, label: string, detail: string): AssetRow => ({
    label,
    ...activity(name),
    glyph: assetIcons.scene,
    detail,
  });
  return [
    builtIn(STUDIO_SCENE_NAME, t("preview.sceneStudio"), t("content.sceneStudioTip")),
    ...selectSceneAssets(store).map((asset): AssetRow => ({
      label: asset.label,
      ...activity(asset.name),
      glyph: assetIcons.scene,
      detail: formatBytes(asset.byteSize),
      download: () => save(uploadedFile(asset)),
      remove: () => removeSceneAsset(store, asset.name),
    })),
  ];
}

/** `onBake` opens the SDF baker on a mesh. */
export function meshRows(store: Store, onBake: (mesh: MeshAsset) => void): readonly AssetRow[] {
  const assets = selectMeshAssets(store);
  const thumbnails = meshThumbnails(assets);
  const usage = selectAssetUsage(store, "mesh");
  return assets.map((asset: MeshAsset) => {
    const thumbnailUrl = thumbnails.get(asset.name);
    return {
      label: asset.label,
      users: usage.get(asset.name) ?? 0,
      ...(thumbnailUrl !== undefined ? { thumbnailUrl } : {}),
      glyph: assetIcons.mesh,
      detail: formatBytes(asset.byteSize),
      twoLines: true,
      controls: [
        ...meshPreviewControls(store, asset),
        {
          kind: "button",
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

/** How the preview draws a mesh: the clip a skinned one plays, and whether it is shown at the
 *  scene's centre. */
function meshPreviewControls(store: Store, asset: MeshAsset): readonly AssetRowControl[] {
  const shown = asset.shownInScene === true;
  const clips = asset.geometry.skin?.clips ?? [];
  const clip = previewClipOf(asset);
  return [
    ...(clip === undefined
      ? []
      : [
          {
            kind: "choice",
            options: clips.map((each) => ({ value: each.name, label: each.name })),
            value: clip.name,
            title: t("content.clip"),
            description: t("content.clipTip"),
            onChange: (name: string): void =>
              setMeshAssetPreview(store, asset.name, { clip: name }),
          } as const,
        ]),
    {
      kind: "toggle",
      glyph: actionIcons.hidden,
      activeGlyph: actionIcons.visible,
      value: shown,
      title: t(shown ? "content.hideInScene" : "content.showInScene"),
      description: t("content.showInSceneTip"),
      onChange: (on: boolean): void => setMeshAssetPreview(store, asset.name, { shownInScene: on }),
    },
  ];
}

/** The volume rows - the slice atlas as the preview, downloaded as is. */
export function volumeRows(store: Store): readonly AssetRow[] {
  const usage = selectAssetUsage(store, "volume");
  return selectVolumeAssets(store).map((asset: VolumeAsset) => {
    const size = asset.size.join("x");
    return {
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

/**
 * One library row: the preview, the name and its user count, the controls of its kind, download and
 * delete on one line. A two-line row keeps the name, count, download and delete on the first, and
 * puts the controls of its kind on the second.
 */
export function assetRowElement(row: AssetRow): HTMLElement {
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
  if (row.detail !== undefined) {
    attachTooltip(name, row.label, row.detail);
  }
  const heading = [name];
  if (row.users !== undefined) {
    const count = createElement("span", {
      className: "asset-row__count",
      textContent: String(row.users),
    });
    attachTooltip(
      count,
      t("content.usersTitle"),
      row.usersTooltip ?? t("content.usersTip", { count: String(row.users) }),
    );
    heading.push(count);
  }

  const download = row.download;
  const remove = row.remove;
  const fileControls: AssetRowControl[] = [
    ...(download === undefined
      ? []
      : [
          {
            kind: "button",
            glyph: assetIcons.download,
            title: t("content.download"),
            description: t("content.downloadTip"),
            run: download,
          } as const,
        ]),
    ...(remove === undefined
      ? []
      : [
          {
            kind: "confirm",
            glyph: actionIcons.trash,
            title: t("content.deleteAsset"),
            description: t("content.deleteAssetTip"),
            clicks: DELETE_CLICKS,
            run: remove,
          } as const,
        ]),
  ];

  const kindElements = (row.controls ?? []).map(controlElement);
  const fileElements = fileControls.map(controlElement);
  const lines =
    row.twoLines !== true
      ? [[...heading, ...kindElements, ...fileElements]]
      : [[...heading, ...fileElements], kindElements];
  const classes = ["asset-row", `asset-row--lines-${String(lines.length)}`, row.className ?? ""];
  return createElement("div", { className: classes.join(" ").trim() }, [
    preview,
    createElement(
      "div",
      { className: "asset-row__body" },
      lines.map((line) => createElement("div", { className: "asset-row__line" }, line)),
    ),
  ]);
}

/** A row control's element: as tall as the line, an icon one square, a guarded one tinted as
 *  `.confirm-danger` and the others plain. */
function controlElement(control: AssetRowControl): HTMLElement {
  switch (control.kind) {
    case "button": {
      const button = createElement("button", {
        className: "asset-row__control asset-row__control--plain asset-row__control--square",
        type: "button",
      });
      button.append(icon(control.glyph));
      attachTooltip(button, control.title, control.description);
      button.addEventListener("click", () => control.run());
      return button;
    }
    case "toggle":
      return createToggleButton({
        baseClassName: "asset-row__control",
        className: "asset-row__control--plain asset-row__control--square",
        glyph: control.glyph,
        activeGlyph: control.activeGlyph,
        value: control.value,
        title: control.title,
        description: control.description,
        onChange: (on) => control.onChange(on),
      }).element;
    case "choice": {
      const choice = new Dropdown({
        options: control.options,
        value: control.value,
        onChange: (value): void => control.onChange(value),
        className: "asset-row__control asset-row__control--plain asset-row__choice",
        ariaLabel: control.title,
      });
      attachTooltip(choice.element, control.title, control.description);
      return choice.element;
    }
    case "confirm": {
      const content =
        control.label === undefined
          ? control.glyph
          : `${control.glyph}<span>${control.label}</span>`;
      const shape = control.label === undefined ? "square" : "labelled";
      const button = createElement("button", {
        className: `asset-row__control asset-row__control--${shape} confirm-danger`,
        type: "button",
      });
      button.innerHTML = content;
      attachTooltip(button, control.title, control.description);
      attachCountdownConfirm(button, content, control.clicks, () => control.run());
      return button;
    }
  }
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
