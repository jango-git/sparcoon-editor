/**
 * The autosaved session: only the source is saved, as JSON in `localStorage`, in the project
 * envelope (`projectEnvelope.ts`). Asset payloads go to IndexedDB (`assetBlobStore.ts`). A save
 * stores the payloads first, then writes the document once without them. {@link hydrateSource}
 * reverses this on load.
 */

import type { SourceState } from "../model/editorState";
import { readString, writeJson } from "../util/storage";
import type { BlobSync } from "./assetBlobStore";
import { environmentBlobs, meshBlobs, textureBlobs, volumeBlobs } from "./assetBlobStore";
import { wrapProject } from "./projectEnvelope";

const STORAGE_KEY = "sparcoon-editor.document";

/** One asset library of the source, bound to where its payloads are stored. Each one owns a
 *  field of the source of its own, so the three run independently - in parallel on load. */
interface StoredLibrary {
  /** This library's field of `source`, its stored payloads left out. */
  strip(source: SourceState): Partial<SourceState>;
  /** Brings the stored payloads in line with `source`. */
  sync(source: SourceState): Promise<void>;
  /** This library's field of `source`, its emptied payloads filled back in. */
  hydrate(source: SourceState): Promise<Partial<SourceState>>;
}

function storedLibrary<T extends { readonly name: string }, P>(
  blobs: BlobSync<T, P>,
  assetsOf: (source: SourceState) => readonly T[],
  field: (assets: readonly T[]) => Partial<SourceState>,
): StoredLibrary {
  return {
    strip: (source) => field(assetsOf(source).map((asset) => blobs.strip(asset))),
    sync: (source) => blobs.sync(assetsOf(source)),
    hydrate: async (source) => field(await blobs.hydrate(assetsOf(source))),
  };
}

const LIBRARIES: readonly StoredLibrary[] = [
  storedLibrary(
    textureBlobs,
    (source) => source.assets,
    (assets) => ({ assets }),
  ),
  storedLibrary(
    environmentBlobs,
    (source) => source.environments,
    (environments) => ({ environments }),
  ),
  storedLibrary(
    meshBlobs,
    (source) => source.meshAssets,
    (meshAssets) => ({ meshAssets }),
  ),
  storedLibrary(
    volumeBlobs,
    (source) => source.volumeAssets,
    (volumeAssets) => ({ volumeAssets }),
  ),
];

/** The source of the most recent {@link saveSource} call - an older save must not overwrite it. */
let latestSource: SourceState | undefined;

/**
 * Stores the asset payloads, then writes the document without them. Payloads that could not be
 * stored (IndexedDB unavailable) stay inline, so the document never refers to a missing payload.
 * With nothing new to store, the write happens before this task ends, so a page-hide flush still
 * lands; a page closed while new payloads are being stored keeps the previous document.
 */
export function saveSource(source: SourceState): void {
  latestSource = source;
  void Promise.all(LIBRARIES.map((library) => library.sync(source))).then(() => {
    if (latestSource === source && !writeDocument(source)) {
      // A failed document write is worth a console warning (the user's work), unlike the
      // best-effort silent settings writes.
      console.warn("Failed to save document");
    }
  });
}

/**
 * Reads the raw persisted document as `unknown` - the caller normalizes it to the current source
 * shape ({@link loadInitialState}), defaulting anything missing or malformed, then fills its asset
 * payloads back in with {@link hydrateSource}.
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

/** A normalized persisted source with the asset payloads {@link saveSource} left out filled back in. */
export async function hydrateSource(source: SourceState): Promise<SourceState> {
  const fields = await Promise.all(LIBRARIES.map((library) => library.hydrate(source)));
  return Object.assign({ ...source }, ...fields) as SourceState;
}

function writeDocument(source: SourceState): boolean {
  return writeJson(
    STORAGE_KEY,
    wrapProject(Object.assign({ ...source }, ...LIBRARIES.map((library) => library.strip(source)))),
  );
}
