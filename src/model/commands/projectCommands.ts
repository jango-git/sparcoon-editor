/**
 * Document-level edits (whole project, not one graph). Resetting is structural (recomputes
 * derived) but still goes through history, so an accidental clear is undoable.
 */

import { createInitialState, type SourceState } from "../editorState";
import type { Store } from "../store";
import { seedIdentifierCounterFromSource } from "./documentIdentifiers";

/**
 * Clears the project back to an empty document, discarding all authored content - except the HDRI
 * library, which survives: it is workspace-level content the user builds up across projects, not
 * per-effect authoring, and re-uploading multi-MB HDRIs after every reset would be needless pain.
 */
export function resetProject(store: Store): void {
  const environments = store.getSource().environments;
  store.commit({ ...createInitialState().source, environments }, "structural");
}

/**
 * Replaces the document with an imported one (from {@link deserializeProject}); seeds the id
 * counter above its ids first so later-added nodes can't collide. One undo step restores the pre-import document.
 */
export function importProject(store: Store, source: SourceState): void {
  seedIdentifierCounterFromSource(source);
  store.commit(source, "structural");
}

/** Renames the project. View-only: the name is metadata, it feeds no node or derived slot. */
export function setProjectName(store: Store, name: string): void {
  const source = store.getSource();
  if (source.name === name) {
    return;
  }
  store.commit({ ...source, name }, "view");
}
