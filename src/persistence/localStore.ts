/**
 * Persistence: only the *source* is saved - derived data is never written, it is recomputed on
 * load. This is the autosaved-session backing store, a plain localStorage JSON round-trip;
 * `projectFile.ts`'s file export and the TypeScript effect export are separate formats layered
 * on the same {@link SourceState}. HDRI `dataUrl`s are the exception - multi-MB base64 would blow
 * through localStorage's quota, so they are stripped here; the real bytes already live in
 * IndexedDB (written once at upload time - see `assetIngestion.ts`'s `ingestEnvironment` and
 * environmentBlobStore.ts) and are hydrated back on load (`loadState.ts`).
 */

import { readString, writeJson } from "../util/storage";
import type { SourceState } from "../model/editorState";

const STORAGE_KEY = "sparcoon-editor.document";

export function saveSource(source: SourceState): void {
  const stripped: SourceState = {
    ...source,
    environments: source.environments.map((asset) => ({ ...asset, dataUrl: "" })),
  };
  // A failed document write is worth a console warning (the user's work), unlike the best-effort
  // silent settings writes.
  if (!writeJson(STORAGE_KEY, stripped)) {
    console.warn("Failed to save document");
  }
}

/**
 * Reads the raw persisted document as `unknown` - the caller normalizes it to the current source
 * shape ({@link loadInitialState}), defaulting anything missing or malformed.
 */
export function loadSource(): unknown {
  const raw = readString(STORAGE_KEY);
  if (raw === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    console.warn("Failed to parse saved document", error);
    return undefined;
  }
}
