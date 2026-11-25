/**
 * The project file (also the presets): a stored project (`projectEnvelope.ts`) as JSON text, its
 * payloads gzipped (`payloadCodec.ts`). Reading one hands its body to the same
 * {@link readStoredSource} that defends the autosaved document, so a file - untrusted like any
 * storage - can never crash the editor.
 */

import type { SourceState } from "../model/editorState";
import { readStoredSource } from "./loadState";
import { encodeSourceCompressed } from "./payloadCodec";
import { isNewerProject, unwrapProject, wrapProject } from "./projectEnvelope";

/** What reading a project file gave. */
export type ProjectRead =
  | { readonly kind: "loaded"; readonly source: SourceState }
  | { readonly kind: "unreadable" }
  /** Saved in a later format, by `editor` when the file names it: refused whole. */
  | { readonly kind: "newer"; readonly editor: string | undefined };

export async function serializeProject(source: SourceState): Promise<string> {
  return JSON.stringify(wrapProject(await encodeSourceCompressed(source)), undefined, 2);
}

export async function deserializeProject(text: string): Promise<ProjectRead> {
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
  const source = await readStoredSource(stored);
  return source === undefined ? { kind: "unreadable" } : { kind: "loaded", source };
}
