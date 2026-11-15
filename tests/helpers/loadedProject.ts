import type { SourceState } from "../../src/model/editorState";
import { deserializeProject } from "../../src/persistence/projectFile";

/** The source a project file's text loads to, or `undefined` when it does not load. */
export function loadedProject(text: string): SourceState | undefined {
  const read = deserializeProject(text);
  return read.kind === "loaded" ? read.source : undefined;
}
