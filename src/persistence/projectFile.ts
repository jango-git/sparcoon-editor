/**
 * The project file (also the presets): a stored project (`projectEnvelope.ts`) as JSON text.
 * Reading one hands its body to the same {@link readStoredSource} that defends the autosaved
 * document, so a file - untrusted like any storage - can never crash the editor.
 */

import type { SourceState } from "../model/editorState";
import { readStoredSource } from "./loadState";
import { isNewerProject, unwrapProject, wrapProject } from "./projectEnvelope";

/** What reading a project file gave. */
export type ProjectRead =
  | { readonly kind: "loaded"; readonly source: SourceState }
  | { readonly kind: "unreadable" }
  /** Saved in a later format, by `editor` when the file names it: refused whole. */
  | { readonly kind: "newer"; readonly editor: string | undefined };

export function serializeProject(source: SourceState): string {
  return JSON.stringify(wrapProject(source), undefined, 2);
}

export function deserializeProject(text: string): ProjectRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "unreadable" };
  }
  const stored = unwrapProject(raw);
  if (isNewerProject(stored)) {
    return { kind: "newer", editor: stored.editor };
  }
  const source = readStoredSource(stored);
  return source === undefined ? { kind: "unreadable" } : { kind: "loaded", source };
}
