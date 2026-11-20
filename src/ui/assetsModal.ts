/**
 * Content screen: a modal sheet (opens from the middlebar, closes on scrim/Escape) rather than a
 * persistent panel, since content isn't always needed. Three blocks sit side by side, all on one
 * screen with no tabs: Content (one unified, vertically-scrolling asset list - images, HDRIs, GLB
 * meshes and baked volumes stack as sections rather than parallel columns), Project (name/save-load/
 * examples/export) and Help (a static quick-reference). A single "Upload asset" affordance
 * (button or drag-drop) routes dropped files to their library by type, and drag-drop is live over
 * the whole sheet regardless of which block it lands on. A row's user count is the nodes using the
 * asset (and the surfaces drawing a mesh), for an HDRI whether it is the active one.
 */

import { t } from "../i18n";
import type { MeshAsset } from "../model/editorState";
import { selectTextureAssetUsage } from "../model/selectors";
import { HDRI_EXTENSIONS, ingestFiles, MESH_EXTENSIONS } from "./assetIngestion";
import { environmentRows, fillColumn, meshRows, textureRows, volumeRows } from "./assetRows";
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
  const uploadButton = outlineButton(
    assetIcons.upload,
    t("content.uploadAsset"),
    t("content.uploadTip"),
    "content-sheet__upload",
  );

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ["image/*", ...HDRI_EXTENSIONS, ...MESH_EXTENSIONS].join(",");
  fileInput.multiple = true;
  fileInput.className = "content-sheet__file";

  const imageList = createElement("div", { className: "content-group__rows" });
  const hdriList = createElement("div", { className: "content-group__rows" });
  const meshList = createElement("div", { className: "content-group__rows" });
  const volumeList = createElement("div", { className: "content-group__rows" });

  // The Content block: a header (title + upload) over one unified, vertically-scrolling list - the
  // three asset types stack as sections (see assetGroup) rather than side-by-side columns, so the
  // block reads as one library with a single scrollbar, not three.
  const main = createElement("div", { className: "content-sheet__main" }, [
    createElement("div", { className: "content-sheet__header" }, [
      createElement("span", { className: "content-sheet__title", textContent: t("content.title") }),
      createElement("div", { className: "content-sheet__spacer" }),
      uploadButton,
      fileInput,
    ]),
    createElement("div", { className: "content-list" }, [
      assetGroup(t("content.columnImages"), imageList),
      assetGroup(t("content.columnMeshes"), meshList),
      assetGroup(t("content.columnVolumes"), volumeList),
      assetGroup(t("content.columnHdri"), hdriList),
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
    exportPanel.sync();
  };

  const ingest = (files: FileList | undefined): void => {
    void ingestFiles(files, store);
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

  uploadButton.addEventListener("click", () => fileInput.click());
  closeButton.addEventListener("click", () => close());
  fileInput.addEventListener("change", () => {
    ingest(fileInput.files ?? undefined);
    fileInput.value = "";
  });
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

  // Prevent-default on dragover is what makes the sheet a valid drop target; the highlight class
  // gives the drag visible feedback.
  sheet.addEventListener("dragover", (event) => {
    event.preventDefault();
    sheet.classList.add("content-sheet--dropping");
  });
  sheet.addEventListener("dragleave", (event) => {
    if (event.target === sheet) {
      sheet.classList.remove("content-sheet--dropping");
    }
  });
  sheet.addEventListener("drop", (event) => {
    event.preventDefault();
    sheet.classList.remove("content-sheet--dropping");
    ingest(event.dataTransfer?.files ?? undefined);
  });

  // Re-render whenever the document changes (an upload/delete here, or an undo/redo). Texture edits
  // are structural; environment/mesh edits are view-only - listen to both so every section refreshes.
  // The HDRI rows' active-environment badge also refreshes when the Lighting panel changes it.
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
