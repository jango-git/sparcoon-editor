/**
 * Bundled starter projects, offered on the Content screen's Import/Export panel and used as the
 * first-load fallback (`main.ts`). Loaded the same way locale dictionaries are - fetched at
 * runtime from `dist/presets/<fileName>` (`rollup.config.js`'s `copyJsonAssets` copies this
 * directory's own `.json` files there, mirroring `copyJsonAssets("src/i18n/locales", "locales")`)
 * rather than imported as a module, so parsing can reuse {@link deserializeProject} without an
 * import cycle back into `loadState.ts` (which is also where the first-load fallback is decided).
 */

import type { TKey } from "../../i18n";
import { createInitialState, type SourceState } from "../../model/editorState";
import { deserializeProject } from "../projectFile";

export interface ProjectPreset {
  readonly id: string;
  readonly labelKey: TKey;
  /** Absent for the built-in empty document; otherwise a filename fetched from this directory. */
  readonly fileName?: string;
}

export const EMPTY_PRESET: ProjectPreset = { id: "empty", labelKey: "content.presetEmpty" };
export const SPARKS_PRESET: ProjectPreset = {
  id: "sparks",
  labelKey: "content.presetSparks",
  fileName: "sparks.json",
};

/** Empty first, so it reads as the "start over" option. */
export const PROJECT_PRESETS: readonly ProjectPreset[] = [EMPTY_PRESET, SPARKS_PRESET];

export const DEFAULT_PROJECT_PRESET = SPARKS_PRESET;

/** Never throws - an unreadable/unreachable preset falls back to the empty document, with a
 *  console warning, the same way a corrupt saved document does. */
export async function loadPresetSource(preset: ProjectPreset): Promise<SourceState> {
  if (preset.fileName === undefined) {
    return createInitialState().source;
  }
  try {
    // Resolve next to the bundle (dist/presets/...), mirroring the copy-locales build step
    // (i18n/index.ts) - a bare `preset.fileName` would resolve against the bundle chunk's own
    // location (dist/), one directory short of where copyJsonAssets actually puts it.
    const response = await fetch(new URL(`presets/${preset.fileName}`, import.meta.url));
    const source = deserializeProject(await response.text());
    if (source !== undefined) {
      return source;
    }
    console.warn(`Preset "${preset.id}" is not a readable project file; starting empty`);
  } catch (error) {
    console.warn(`Failed to load preset "${preset.id}"; starting empty`, error);
  }
  return createInitialState().source;
}
