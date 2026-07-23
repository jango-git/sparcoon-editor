/**
 * The Import/Export block of the Content sheet: full-height, borderless, grouped top-down - name,
 * JSON import/export, TypeScript export, then the bundled Examples list last (the one destructive
 * action in the block, kept below the two that only ever add output).
 */

import { t } from "../i18n";
import { importProject, setProjectName } from "../model/commands";
import type { Store } from "../model/store";
import { hydrateEnvironmentBlobs } from "../persistence/environmentBlobStore";
import { emitProjectModule } from "../persistence/exportTypeScript";
import {
  EMPTY_PRESET,
  loadPresetSource,
  PROJECT_PRESETS,
  SPARKS_PRESET,
  type ProjectPreset,
} from "../persistence/presets";
import { deserializeProject, serializeProject } from "../persistence/projectFile";
import { attachCountdownConfirm } from "./components/countdownConfirm";
import { attachTooltip } from "./components/tooltip";
import { createElement } from "./dom";
import type { EditorContext } from "./editorContext";
import { assetIcons, icon, timelineIcons } from "./icons";

/** Presses to confirm applying a preset (destructive - replaces the whole project - so guarded
 *  harder than a per-asset delete). */
const PRESET_APPLY_CLICKS = 5;

/** Each preset's row preview - a kind glyph, the same role a thumbnail plays for an asset row. */
const PRESET_GLYPHS: Readonly<Record<string, string>> = {
  [EMPTY_PRESET.id]: assetIcons.blank,
  [SPARKS_PRESET.id]: timelineIcons.burst,
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

  // A hidden picker restricted to JSON; the Import button opens it, a pick loads the project.
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "application/json,.json";
  fileInput.className = "content-sheet__file";
  fileInput.addEventListener("change", () => {
    void importFromFile(fileInput.files?.[0], context);
    fileInput.value = "";
  });

  // Save the project to a JSON file, or load one back: save sends out (up-arrow), load pulls in (down).
  const saveButton = exportButton(assetIcons.download, t("content.saveJson"));
  saveButton.addEventListener("click", () => exportProject(store));
  const loadButton = exportButton(assetIcons.upload, t("content.loadJson"));
  loadButton.addEventListener("click", () => fileInput.click());

  const jsonRow = createElement("div", { className: "content-export__row" }, [
    saveButton,
    loadButton,
    fileInput,
  ]);

  // Bundled starter projects - a small project-style row list, one per PROJECT_PRESETS entry
  // (the empty document first). Each apply is guarded the same way a per-asset delete is.
  const examplesTitle = createElement("div", {
    className: "content-group__title",
    textContent: t("content.examples"),
  });
  const examplesList = createElement(
    "div",
    { className: "content-export__examples" },
    PROJECT_PRESETS.map((preset) => presetRow(context, preset)),
  );

  // The embed flag is grouped above the TypeScript export it's meant to govern once wired (still
  // inert - see file doc); a visible label carries its name, the tooltip the detail.
  const embedField = createElement("label", { className: "content-export__embed" }, [
    createElement("input", { className: "param__checkbox", type: "checkbox" }),
    createElement("span", { textContent: t("content.embedAssets") }),
  ]);
  attachTooltip(embedField, t("content.embedAssets"), t("content.embedAssetsTip"));
  const typeScriptButton = exportButton(assetIcons.upload, t("content.exportTypeScript"));
  typeScriptButton.addEventListener("click", () => exportTypeScript(store));
  const typeScriptGroup = createElement("div", { className: "content-export__group" }, [
    embedField,
    typeScriptButton,
  ]);

  const form = createElement("div", { className: "content-export__form" }, [
    nameField,
    jsonRow,
    typeScriptGroup,
    examplesTitle,
    examplesList,
  ]);

  const sync = (): void => {
    if (document.activeElement !== nameInput) {
      nameInput.value = store.getSource().name;
    }
  };

  return { element: createElement("div", { className: "content-export" }, [title, form]), sync };
}

/** Serializes the current document to a JSON file and triggers a download named after the project. */
function exportProject(store: Store): void {
  downloadText(
    serializeProject(store.getSource()),
    store.getSource().name,
    "json",
    "application/json",
  );
}

/** Emits the project as a self-contained TypeScript effect module and downloads it as `<name>.ts`. */
function exportTypeScript(store: Store): void {
  const source = store.getSource();
  let module: string;
  try {
    module = emitProjectModule(source);
  } catch (error) {
    // A graph that fails to compile (mid-edit invalid state) must not crash the editor; surface it
    // and leave the document untouched.
    window.alert(
      `${t("content.exportTypeScript")}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  downloadText(module, source.name, "ts", "text/plain");
}

/** Triggers a browser download of `text` as `<projectFileName>.<extension>`. */
function downloadText(text: string, name: string, extension: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${projectFileName(name)}.${extension}`;
  link.click();
  // Revoke on a later tick: some browsers cancel the in-flight download if the object URL is
  // released synchronously, before the save has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Reads a picked JSON file and replaces the document, warning (without touching it) on a bad file.
 *  Also resets the viewport's own persisted settings (Lighting/Scene/Gizmo) to factory defaults -
 *  they live outside the document, so a document replace alone would otherwise leave the previous
 *  project's studio setup and gizmo preferences in place. */
async function importFromFile(file: File | undefined, context: EditorContext): Promise<void> {
  if (file === undefined) {
    return;
  }
  const source = deserializeProject(await file.text());
  if (source === undefined) {
    console.warn(`"${file.name}" is not a readable project file`);
    return;
  }
  await hydrateEnvironmentBlobs(source.environments);
  importProject(context.store, source);
  context.previewSettings.reset();
  context.gizmoSettings.reset();
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

/** Loads a preset's source (bundled JSON fetch, or the built-in empty document) and replaces the
 *  document with it - the same path a picked JSON file goes through, viewport settings reset
 *  included. */
async function applyPreset(context: EditorContext, preset: ProjectPreset): Promise<void> {
  const source = await loadPresetSource(preset);
  await hydrateEnvironmentBlobs(source.environments);
  importProject(context.store, source);
  context.previewSettings.reset();
  context.gizmoSettings.reset();
}

/** A safe download stem from the project name: keep word characters, fall back when nothing remains. */
function projectFileName(name: string): string {
  const stem = name
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return stem === "" ? "sparcoon-project" : stem;
}

/** One full-width outline button in the Import/Export block (icon + label). */
function exportButton(glyph: string, label: string): HTMLButtonElement {
  const button = createElement("button", { className: "content-export__button", type: "button" });
  button.append(icon(glyph), createElement("span", { textContent: label }));
  return button;
}
