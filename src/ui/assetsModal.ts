/**
 * Content screen: a modal sheet (opens from the middlebar, closes on scrim/Escape) rather than a
 * persistent panel, since content isn't always needed. Three blocks sit side by side, all on one
 * screen with no tabs: Content (one unified, vertically-scrolling asset list - images, GLB meshes,
 * baked volumes, HDRIs and preview scenes stack as sections rather than parallel columns), Project
 * (name/save-load/examples/export) and Help (a static quick-reference). A single "Upload asset"
 * affordance (button or drag-drop) routes dropped files to their library by type, and drag-drop is
 * live over the whole sheet regardless of which block it lands on. The Scenes section has an upload
 * and a drop area of its own, since a GLB dropped anywhere else is a mesh. A row's user count is the
 * nodes using the asset (and the surfaces drawing a mesh), for an HDRI or a scene whether it is the
 * active one.
 */

import { t } from "../i18n";
import type { MeshAsset } from "../model/editorState";
import { selectTextureAssetUsage } from "../model/selectors";
import {
  HDRI_EXTENSIONS,
  ingestFiles,
  ingestSceneFiles,
  MESH_EXTENSIONS,
  SCENE_EXTENSIONS,
} from "./assetIngestion";
import {
  environmentRows,
  fillColumn,
  meshRows,
  sceneRows,
  textureRows,
  volumeRows,
} from "./assetRows";
import { attachTooltip } from "./components/tooltip";
import { helpBlock } from "./contentHelpPanel";
import { createElement } from "./dom";
import type { EditorContext } from "./editorContext";
import { assetIcons, glyphIcons, icon } from "./icons";
import { outlineButton } from "./outlineButton";
import { exportBlock } from "./projectExportPanel";
import { createVolumeBaker } from "./volumeBaker";

export interface AssetsModal {
  readonly element: HTMLElement;
  open(): void;
  close(): void;
}

export function createAssetsModal(context: EditorContext): AssetsModal {
  const { store } = context;
  const ingest = (files: FileList | undefined): void => {
    void ingestFiles(files, store);
  };
  const upload = uploadControl(
    t("content.uploadAsset"),
    t("content.uploadTip"),
    "content-sheet__upload",
    ["image/*", ...HDRI_EXTENSIONS, ...MESH_EXTENSIONS],
    ingest,
  );

  const imageList = createElement("div", { className: "content-group__rows" });
  const hdriList = createElement("div", { className: "content-group__rows" });
  const meshList = createElement("div", { className: "content-group__rows" });
  const volumeList = createElement("div", { className: "content-group__rows" });
  const sceneList = createElement("div", { className: "content-group__rows" });

  // The Content block: a header (title + upload) over one unified, vertically-scrolling list - the
  // asset kinds stack as sections (see assetGroup) rather than side-by-side columns, so the block
  // reads as one library with a single scrollbar.
  const main = createElement("div", { className: "content-sheet__main" }, [
    createElement("div", { className: "content-sheet__header" }, [
      createElement("span", { className: "content-sheet__title", textContent: t("content.title") }),
      createElement("div", { className: "content-sheet__spacer" }),
      ...upload,
    ]),
    createElement("div", { className: "content-list" }, [
      assetGroup(t("content.columnImages"), imageList),
      assetGroup(t("content.columnMeshes"), meshList),
      assetGroup(t("content.columnVolumes"), volumeList),
      assetGroup(t("content.columnHdri"), hdriList),
      sceneGroup(sceneList, (files) => void ingestSceneFiles(files, store)),
    ]),
  ]);

  const exportPanel = exportBlock(context);
  const help = helpBlock();
  // Danger-tinted like the block's reset button - shares its .confirm-danger look, minus the
  // countdown-confirm behavior (a close needs no guard). Sits above the Help block it overlays,
  // the rightmost of the three.
  const closeButton = createElement("button", {
    className: "content-sheet__close confirm-danger",
    type: "button",
  });
  closeButton.append(icon(glyphIcons.close));
  attachTooltip(closeButton, t("content.close"), t("content.closeTip"));
  const blocks = [main, exportPanel.element, help.element];
  const sheet = createElement("div", { className: "content-sheet" }, [...blocks, closeButton]);
  const scrim = createElement("div", { className: "modal-scrim" }, [sheet]);

  // The SDF baker takes the sheet in place of the blocks and the close button, and gives it back
  // when done.
  const showBlocks = (): void => sheet.replaceChildren(...blocks, closeButton);
  const baker = createVolumeBaker(store, showBlocks);
  const openBaker = (mesh: MeshAsset): void => {
    sheet.replaceChildren(baker.element);
    baker.open(mesh);
  };

  const render = (): void => {
    const usage = selectTextureAssetUsage(store);
    const environments = environmentRows(store, render);
    fillColumn(imageList, t("content.emptyImages"), textureRows(store, usage));
    fillColumn(hdriList, t("content.emptyHdri"), environments);
    fillColumn(meshList, t("content.emptyMeshes"), meshRows(store, openBaker));
    fillColumn(volumeList, t("content.emptyVolumes"), volumeRows(store));
    fillColumn(sceneList, "", sceneRows(store));
    exportPanel.sync();
  };

  const close = (): void => {
    baker.close();
    showBlocks();
    scrim.classList.remove("modal-scrim--open");
  };
  const open = (): void => {
    render();
    scrim.classList.add("modal-scrim--open");
  };

  closeButton.addEventListener("click", () => close());
  scrim.addEventListener("click", (event) => {
    if (event.target === scrim) {
      close();
    }
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      close();
    }
  });

  acceptDrops(sheet, "content-sheet--dropping", ingest);

  // Re-render whenever the document changes (an upload/delete here, or an undo/redo). Texture edits
  // are structural; environment/scene edits are view-only - listen to both so every section
  // refreshes. The HDRI and scene rows' active badges also refresh when the viewport settings
  // change them.
  store.events.sourceStructureChanged.on(render);
  store.events.sourceViewChanged.on(render);
  render();

  return { element: scrim, open, close };
}

/** One asset-type section within the unified Content list: a subgroup title over its rows. */
function assetGroup(title: string, rows: HTMLElement): HTMLElement {
  const titleElement = createElement("div", {
    className: "content-group__title",
    textContent: title,
  });
  return createElement("div", { className: "content-group" }, [titleElement, rows]);
}

/** The Scenes section: a title row with its own upload, over its rows, and its own drop area. */
function sceneGroup(rows: HTMLElement, ingest: (files: FileList | undefined) => void): HTMLElement {
  const header = createElement("div", { className: "content-group__header" }, [
    createElement("div", {
      className: "content-group__title",
      textContent: t("content.columnScenes"),
    }),
    createElement("div", { className: "content-sheet__spacer" }),
    ...uploadControl(
      t("content.uploadScene"),
      t("content.uploadSceneTip"),
      "content-sheet__upload",
      SCENE_EXTENSIONS,
      ingest,
    ),
  ]);
  const group = createElement("div", { className: "content-group" }, [header, rows]);
  acceptDrops(group, "content-group--dropping", ingest);
  return group;
}

/** An upload button and the hidden file input it opens, handing the picked files to `ingest`. */
function uploadControl(
  label: string,
  tip: string,
  className: string,
  accept: readonly string[],
  ingest: (files: FileList | undefined) => void,
): readonly HTMLElement[] {
  const button = outlineButton(assetIcons.upload, label, tip, className);
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept.join(",");
  input.multiple = true;
  input.className = "content-sheet__file";
  button.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    ingest(input.files ?? undefined);
    input.value = "";
  });
  return [button, input];
}

/**
 * Makes `element` a drop target for files, with `droppingClass` on it while files are over it. A
 * drop a drop target inside it already took is left alone.
 */
function acceptDrops(
  element: HTMLElement,
  droppingClass: string,
  ingest: (files: FileList | undefined) => void,
): void {
  element.addEventListener("dragover", (event) => {
    event.preventDefault();
    element.classList.add(droppingClass);
  });
  element.addEventListener("dragleave", (event) => {
    const entered = event.relatedTarget;
    if (!(entered instanceof Node) || !element.contains(entered)) {
      element.classList.remove(droppingClass);
    }
  });
  element.addEventListener("drop", (event) => {
    element.classList.remove(droppingClass);
    if (event.defaultPrevented) {
      return;
    }
    event.preventDefault();
    ingest(event.dataTransfer?.files ?? undefined);
  });
}
