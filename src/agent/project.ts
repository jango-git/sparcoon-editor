/**
 * Whole-project agent calls: the project file in and out, bundled presets, and the TypeScript
 * export. They use the same paths as the Content screen's Import/Export block.
 */

import { setProjectName } from "../model/commands";
import { emitProjectModule } from "../persistence/exportTypeScript";
import { loadPresetSource, PROJECT_PRESETS } from "../persistence/presets";
import { deserializeProject, serializeProject } from "../persistence/projectFile";
import { replaceDocument, type DocumentReplaceTarget } from "../persistence/replaceDocument";
import { AgentError } from "./errors";
import { sceneView, type SceneView } from "./views";

export interface ProjectApi {
  /** The project file (`.json`) text, assets inlined. */
  get(): string;
  /**
   * Replaces the document with a project file's text (one undo step) and returns the loaded scene,
   * as `scene.get()` would. Damaged parts of a readable file are repaired or dropped silently, the
   * same as on the editor's own load; compile problems are reported by `status()`.
   */
  load(json: string): Promise<SceneView>;
  /** Ids of the bundled starter projects. */
  presets(): readonly string[];
  /** Replaces the document with a bundled preset and returns the loaded scene. */
  loadPreset(id: string): Promise<SceneView>;
  /**
   * Names the project (one undo step). The name is the exported class's name (PascalCased) and
   * the file stem; blank falls back to "Effect".
   */
  setName(name: string): void;
  /** The self-contained TypeScript effect module the editor exports. */
  exportTypeScript(): string;
}

export function createProjectApi(target: DocumentReplaceTarget): ProjectApi {
  return {
    get: () => serializeProject(target.store.getSource()),

    // Loading is synchronous; the agent API still returns a promise, rejecting rather than throwing.
    load: (json): Promise<SceneView> => {
      const source = deserializeProject(json);
      if (source === undefined) {
        return Promise.reject(new AgentError("invalid_argument", "Not a readable project file."));
      }
      replaceDocument(target, source);
      return Promise.resolve(sceneView(target.store.getSource()));
    },

    presets: () => PROJECT_PRESETS.map((preset) => preset.id),

    loadPreset: async (id): Promise<SceneView> => {
      const preset = PROJECT_PRESETS.find((candidate) => candidate.id === id);
      if (preset === undefined) {
        throw new AgentError("not_found", `No preset "${id}".`);
      }
      replaceDocument(target, await loadPresetSource(preset));
      return sceneView(target.store.getSource());
    },

    setName: (name): void => {
      if (typeof name !== "string") {
        throw new AgentError("invalid_argument", "name must be a string.");
      }
      setProjectName(target.store, name);
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
