/**
 * Whole-project agent calls: the project file in and out, bundled presets, the TypeScript export
 * and the asset zip. They use the same paths as the Content screen's Import/Export block.
 */

import { setProjectName } from "../model/commands";
import { emitProjectModule } from "../persistence/exportTypeScript";
import { loadPresetSource, PROJECT_PRESETS } from "../persistence/presets";
import { deserializeProject, serializeProject } from "../persistence/projectFile";
import { type DocumentReplaceTarget, replaceDocument } from "../persistence/replaceDocument";
import { libraryZip } from "../ui/assetFiles";
import { bytesToBase64 } from "../util/bytes";
import { AgentError } from "./errors";
import { type SceneView, sceneView } from "./views";

export interface ProjectApi {
  /** The project file (`.json`) text, assets inlined. */
  get(): Promise<string>;
  /**
   * Replaces the document with a project file's text (one undo step) and returns the loaded scene,
   * as `scene.get()` would. Damaged parts of a readable file are repaired or dropped silently, the
   * same as on the editor's own load; compile problems are reported by `status()`. A project saved
   * in a later format is rejected.
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
  /** The zip of the library's images, meshes and volumes the editor exports, as base64. */
  exportZip(): Promise<string>;
}

export function createProjectApi(target: DocumentReplaceTarget): ProjectApi {
  return {
    get: () => serializeProject(target.store.getSource(), target.camera.view),

    load: async (json): Promise<SceneView> => {
      const read = await deserializeProject(json);
      if (read.kind === "newer") {
        throw new AgentError(
          "invalid_argument",
          `The project was saved by Sparcoon Editor ${read.editor ?? "?"} in a later format.`,
        );
      }
      if (read.kind === "unreadable") {
        throw new AgentError("invalid_argument", "Not a readable project file.");
      }
      replaceDocument(target, read.source, read.camera);
      return sceneView(target.store.getSource());
    },

    presets: () => PROJECT_PRESETS.map((preset) => preset.id),

    loadPreset: async (id): Promise<SceneView> => {
      const preset = PROJECT_PRESETS.find((candidate) => candidate.id === id);
      if (preset === undefined) {
        throw new AgentError("not_found", `No preset "${id}".`);
      }
      const loaded = await loadPresetSource(preset);
      replaceDocument(target, loaded.source, loaded.camera);
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

    exportZip: async (): Promise<string> =>
      bytesToBase64(await libraryZip(target.store.getSource())),
  };
}
