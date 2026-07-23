/**
 * Document-level edits (whole project, not one graph). Importing is structural (recomputes
 * derived) but still goes through history, so an accidental replace is undoable.
 */

import type { SourceState } from "../editorState";
import type { Store } from "../store";
import { seedIdentifierCounterFromSource } from "./documentIdentifiers";

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
