/**
 * The Import/Export block of the Content sheet: full-height, borderless, grouped top-down - name,
 * JSON import/export, the TypeScript and asset zip exports, then the bundled Examples list last (the one destructive
 * action in the block, kept below the two that only ever add output).
 */

import { t, type TKey } from "../i18n";
import { setProjectName } from "../model/commands";
import type { Store } from "../model/store";
import { emitProjectModule } from "../persistence/exportTypeScript";
import {
  EFFECT_PRESETS,
  EMPTY_PRESET,
  loadPresetSource,
  PROJECT_PRESETS,
  type ProjectPreset,
  SPARKS_PRESET,
} from "../persistence/presets";
import { deserializeProject, serializeProject } from "../persistence/projectFile";
import { replaceDocument } from "../persistence/replaceDocument";
import { libraryZip } from "./assetFiles";
import { attachCountdownConfirm } from "./components/countdownConfirm";
import { attachTooltip } from "./components/tooltip";
import { createElement } from "./dom";
import { downloadFile } from "./download";
import type { EditorContext } from "./editorContext";
import { assetIcons, icon, timelineIcons } from "./icons";
import { outlineButton } from "./outlineButton";

/** Presses to confirm applying a preset (destructive - replaces the whole project - so guarded
 *  harder than a per-asset delete). */
const PRESET_APPLY_CLICKS = 5;

/** Each preset's row preview - a kind glyph, the same role a thumbnail plays for an asset row. */
const PRESET_GLYPHS: Readonly<Record<string, string>> = {
  [EMPTY_PRESET.id]: assetIcons.blank,
  [SPARKS_PRESET.id]: timelineIcons.burst,
  ...Object.fromEntries(EFFECT_PRESETS.map((preset) => [preset.id, timelineIcons.burst])),
};

/**
 * Builds the Import/Export block. `sync` refreshes the name field from the document, skipping the
 * update while the field is focused so it can't stomp mid-edit text.
 */
export function exportBlock(context: EditorContext): { element: HTMLElement; sync: () => void } {
  const { store } = context;
  const title = createElement("div", {
    className: "content-sheet__title content-export__title",
    textContent: t("content.columnProject"),
  });

  const nameInput = createElement("input", {
    className: "param__input content-export__input",
    type: "text",
    attributes: { placeholder: t("content.projectNamePlaceholder") },
  });
  nameInput.value = store.getSource().name;
  // Commit on change (blur/Enter), not per keystroke - one history step per rename, not one per key.
  nameInput.addEventListener("change", () => setProjectName(store, nameInput.value));
  const nameField = createElement("label", { className: "content-export__field" }, [
    createElement("span", {
      className: "content-export__label",
      textContent: t("content.projectName"),
    }),
    nameInput,
  ]);

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "application/json,.json";
  fileInput.className = "content-sheet__file";
  fileInput.addEventListener("change", () => {
    void importFromFile(fileInput.files?.[0], context);
    fileInput.value = "";
  });

  const saveButton = exportButton(assetIcons.download, "content.saveJson", "content.saveJsonTip");
  saveButton.addEventListener("click", () => void saveProjectJson(store));
  const loadButton = exportButton(assetIcons.upload, "content.loadJson", "content.loadJsonTip");
  loadButton.addEventListener("click", () => fileInput.click());

  const jsonRow = createElement("div", { className: "content-export__row" }, [
    saveButton,
    loadButton,
    fileInput,
  ]);

  // Bundled starter projects - a small project-style row list, one per PROJECT_PRESETS entry
  // (the empty document first). Each apply is guarded the same way a per-asset delete is.
  const presetsTitle = createElement("div", {
    className: "content-group__title",
    textContent: t("content.presetsTitle"),
  });
  const presetsList = createElement(
    "div",
    { className: "content-export__examples" },
    PROJECT_PRESETS.map((preset) => presetRow(context, preset)),
  );

  const typeScriptButton = exportButton(
    assetIcons.upload,
    "content.exportTypeScript",
    "content.exportTypeScriptTip",
  );
  typeScriptButton.addEventListener("click", () => exportTypeScript(store));
  const zipButton = exportButton(assetIcons.upload, "content.exportZip", "content.exportZipTip");
  zipButton.addEventListener("click", () => void exportZip(store));

  const form = createElement("div", { className: "content-export__form" }, [
    nameField,
    jsonRow,
    createElement("div", { className: "content-export__row" }, [typeScriptButton, zipButton]),
    presetsTitle,
    presetsList,
  ]);

  const sync = (): void => {
    if (document.activeElement !== nameInput) {
      nameInput.value = store.getSource().name;
    }
  };

  return { element: createElement("div", { className: "content-export" }, [title, form]), sync };
}

/** A button of the block. */
function exportButton(glyph: string, labelKey: TKey, tipKey: TKey): HTMLButtonElement {
  return outlineButton(glyph, t(labelKey), t(tipKey), "content-export__button");
}

/** Serializes the current document to a JSON file and triggers a download named after the project.
 *  Exported so the Ctrl+S hotkey (installHotkeys in hotkeys.ts) can share this exact save path
 *  with the Import/Export panel's own Save button. */
export async function saveProjectJson(store: Store): Promise<void> {
  const source = store.getSource();
  const text = await serializeProject(source);
  downloadFile(projectFileName(source.name, "json"), text, "application/json");
}

/** Emits the project as a self-contained TypeScript effect module and downloads it as `<name>.ts`. */
function exportTypeScript(store: Store): void {
  const source = store.getSource();
  let module: string;
  try {
    module = emitProjectModule(source);
  } catch (error) {
    // A graph that fails to compile (mid-edit invalid state) must not crash the editor. Surface it
    // and leave the document untouched.
    reportExportError("content.exportTypeScript", error);
    return;
  }
  downloadFile(projectFileName(source.name, "ts"), module, "text/plain");
}

/** Downloads the library's images, meshes and volumes as `<name>.zip`. */
async function exportZip(store: Store): Promise<void> {
  const source = store.getSource();
  try {
    downloadFile(projectFileName(source.name, "zip"), await libraryZip(source), "application/zip");
  } catch (error) {
    reportExportError("content.exportZip", error);
  }
}

function reportExportError(labelKey: TKey, error: unknown): void {
  window.alert(`${t(labelKey)}: ${error instanceof Error ? error.message : String(error)}`);
}

/** Reads a picked JSON file and replaces the document (viewport settings reset included - see
 *  {@link replaceDocument}), warning (without touching it) on a bad file and telling the user
 *  about one from a later editor. */
async function importFromFile(file: File | undefined, context: EditorContext): Promise<void> {
  if (file === undefined) {
    return;
  }
  const read = await deserializeProject(await file.text());
  switch (read.kind) {
    case "loaded":
      replaceDocument(context, read.source);
      return;
    case "newer":
      window.alert(t("content.loadNewer", { file: file.name, editor: read.editor ?? "?" }));
      return;
    case "unreadable":
      console.warn(`"${file.name}" is not a readable project file`);
  }
}

/**
 * One Examples row, styled like an asset library row: a kind-glyph preview, the preset's name, a
 * countdown-guarded apply button - same guard/severity as a whole-project replace deserves.
 */
function presetRow(context: EditorContext, preset: ProjectPreset): HTMLElement {
  const preview = createElement("div", { className: "asset-row__preview" }, [
    icon(PRESET_GLYPHS[preset.id] ?? assetIcons.blank),
  ]);
  const name = createElement("span", {
    className: "asset-row__title",
    textContent: t(preset.labelKey),
  });
  const applyContent = `${assetIcons.upload}<span>${t("content.applyPreset")}</span>`;
  const applyButton = createElement("button", {
    className: "content-export__preset-apply confirm-danger",
    type: "button",
  });
  applyButton.innerHTML = applyContent;
  attachTooltip(applyButton, t(preset.labelKey), t("content.applyPresetTip"));
  attachCountdownConfirm(applyButton, applyContent, PRESET_APPLY_CLICKS, () => {
    void applyPreset(context, preset);
  });
  return createElement("div", { className: "asset-row content-export__preset-row" }, [
    preview,
    name,
    createElement("div", { className: "asset-row__spacer" }),
    applyButton,
  ]);
}

/** Loads a preset's bundled JSON and replaces the document with it - the same path a picked JSON
 *  file goes through, viewport settings reset included. */
async function applyPreset(context: EditorContext, preset: ProjectPreset): Promise<void> {
  const source = await loadPresetSource(preset);
  replaceDocument(context, source);
}

/** A safe download stem from the project name: keep word characters, fall back when nothing remains. */
function projectFileName(name: string, extension: string): string {
  const stem = name
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${stem === "" ? "sparcoon-project" : stem}.${extension}`;
}
