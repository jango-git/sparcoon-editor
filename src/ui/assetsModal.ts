/**
 * Content screen: a modal sheet (opens from the middlebar, closes on scrim/Escape) rather than a
 * persistent panel, since content isn't always needed. A header + three independently-scrolling
 * asset libraries (images, HDRIs, GLB meshes) sit beside a separate full-height Import/Export block;
 * a single "Upload asset" affordance (button or drag-drop) routes dropped files to their library by
 * type. The embed-assets flag is still inert - the TypeScript export takes its assets via
 * constructor, not embedded. A row's user count is real for textures (node references) and HDRIs
 * (active or not, ADR-0004), 0 for the not-yet-consumed mesh kind.
 */

import { t } from "../i18n";
import { selectTextureAssetUsage } from "../model/selectors";
import type { SignalBus } from "../model/signals";
import type { Store } from "../model/store";
import type { PreviewSettingsStore } from "../settings/previewSettings";
import { attachTooltip } from "./components/tooltip";
import { createElement } from "./dom";
import { assetIcons, glyphIcons, icon } from "./icons";
import { HDRI_EXTENSIONS, MESH_EXTENSIONS, ingestFiles } from "./assetIngestion";
import { exportBlock } from "./projectExportPanel";
import {
  clearAllEnvironmentsButton,
  environmentRows,
  fillColumn,
  meshRows,
  textureRows,
} from "./assetRows";

export interface AssetsModal {
  readonly element: HTMLElement;
  open(): void;
  close(): void;
}

export function createAssetsModal(
  store: Store,
  signals: SignalBus,
  previewSettings: PreviewSettingsStore,
): AssetsModal {
  const uploadButton = createElement("button", {
    className: "content-sheet__upload",
    type: "button",
  });
  uploadButton.append(
    icon(assetIcons.upload),
    createElement("span", { textContent: t("content.uploadAsset") }),
  );
  attachTooltip(uploadButton, t("content.uploadAsset"), t("content.uploadTip"));

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ["image/*", ...HDRI_EXTENSIONS, ...MESH_EXTENSIONS].join(",");
  fileInput.multiple = true;
  fileInput.className = "content-sheet__file";

  const imageList = createElement("div", { className: "content-column__list" });
  const hdriList = createElement("div", { className: "content-column__list" });
  const meshList = createElement("div", { className: "content-column__list" });
  const clearAllHdri = clearAllEnvironmentsButton(store);

  // The assets side: a header (title + upload) over the three libraries. Export sits apart from it as
  // its own full-height block (it is the special one), so the header spans only the asset columns.
  const main = createElement("div", { className: "content-sheet__main" }, [
    createElement("div", { className: "content-sheet__header" }, [
      createElement("span", { className: "content-sheet__title", textContent: t("content.title") }),
      createElement("div", { className: "content-sheet__spacer" }),
      uploadButton,
      fileInput,
    ]),
    createElement("div", { className: "content-sheet__body" }, [
      assetColumn(t("content.columnImages"), imageList),
      assetColumn(t("content.columnHdri"), hdriList, clearAllHdri),
      assetColumn(t("content.columnMeshes"), meshList),
    ]),
  ]);

  const exportPanel = exportBlock(store);
  // Danger-tinted like the block's reset button - shares its .confirm-danger look, minus the
  // countdown-confirm behavior (a close needs no guard).
  const closeButton = createElement("button", {
    className: "content-sheet__close confirm-danger",
    type: "button",
  });
  closeButton.append(icon(glyphIcons.close));
  attachTooltip(closeButton, t("content.close"), t("content.closeTip"));
  const sheet = createElement("div", { className: "content-sheet" }, [
    main,
    exportPanel.element,
    closeButton,
  ]);
  const scrim = createElement("div", { className: "modal-scrim" }, [sheet]);

  const render = (): void => {
    const usage = selectTextureAssetUsage(store);
    const environments = environmentRows(
      store,
      previewSettings.get().activeEnvironmentName,
      render,
    );
    fillColumn(imageList, t("content.emptyImages"), textureRows(store, usage));
    fillColumn(hdriList, t("content.emptyHdri"), environments);
    fillColumn(meshList, t("content.emptyMeshes"), meshRows(store));
    clearAllHdri.hidden = environments.length === 0;
    exportPanel.sync();
  };

  const ingest = (files: FileList | undefined): void => {
    void ingestFiles(files, store);
  };

  const close = (): void => scrim.classList.remove("modal-scrim--open");
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
  // are structural; environment/mesh edits are view-only - listen to both so every column refreshes.
  signals.on("sourceStructureChanged", render);
  signals.on("sourceViewChanged", render);
  // The HDRI rows' user count follows the active environment, which lives outside the document
  // (ADR-0004) - picking one in the Lighting panel while this sheet is open must still update it.
  previewSettings.subscribe(render);
  render();

  return { element: scrim, open, close };
}

/**
 * One asset library block: a titled header over an independently scrolling list. `headerAction`
 * (the HDRI column's "clear all") sits beside the title instead of inside the scrolling list.
 */
function assetColumn(title: string, list: HTMLElement, headerAction?: HTMLElement): HTMLElement {
  const titleElement = createElement("div", {
    className: "content-column__title",
    textContent: title,
  });
  const header =
    headerAction === undefined
      ? titleElement
      : createElement("div", { className: "content-column__header" }, [titleElement, headerAction]);
  return createElement("div", { className: "content-column" }, [header, list]);
}
