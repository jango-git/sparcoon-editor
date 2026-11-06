/**
 * Whole-project agent calls: the project file in and out, bundled presets, and the TypeScript
 * export. They use the same paths as the Content screen's Import/Export block.
 */

import { emitProjectModule } from "../persistence/exportTypeScript";
import { loadPresetSource, PROJECT_PRESETS } from "../persistence/presets";
import { deserializeProject, serializeProject } from "../persistence/projectFile";
import { replaceDocument, type DocumentReplaceTarget } from "../persistence/replaceDocument";
import { AgentError } from "./errors";

export interface ProjectApi {
  /** The project file (`.json`) text, assets inlined. */
  get(): string;
  /** Replaces the document with a project file's text (one undo step). */
  load(json: string): Promise<void>;
  /** Ids of the bundled starter projects. */
  presets(): readonly string[];
  loadPreset(id: string): Promise<void>;
  /** The self-contained TypeScript effect module the editor exports. */
  exportTypeScript(): string;
}

export function createProjectApi(target: DocumentReplaceTarget): ProjectApi {
  return {
    get: () => serializeProject(target.store.getSource()),

    load: async (json): Promise<void> => {
      const source = deserializeProject(json);
      if (source === undefined) {
        throw new AgentError("invalid_argument", "Not a readable project file.");
      }
      await replaceDocument(target, source);
    },

    presets: () => PROJECT_PRESETS.map((preset) => preset.id),

    loadPreset: async (id): Promise<void> => {
      const preset = PROJECT_PRESETS.find((candidate) => candidate.id === id);
      if (preset === undefined) {
        throw new AgentError("not_found", `No preset "${id}".`);
      }
      await replaceDocument(target, await loadPresetSource(preset));
    },

    exportTypeScript: (): string => {
      try {
        return emitProjectModule(target.store.getSource());
      } catch (error) {
        throw new AgentError(
          "compile_failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
}
