/**
 * The HDRI library's binary payload, kept out of `localStorage` (a multi-MB base64 `.hdr` blows
 * through its ~5-10MB per-origin quota). `saveSource`/`loadState` persist only the light metadata
 * (name/label/byteSize); the actual `dataUrl` round-trips through IndexedDB, keyed by asset name.
 * Never throws - a blocked/unsupported IndexedDB (private mode, disabled) degrades to a miss rather
 * than breaking the caller, mirroring `util/storage.ts`'s localStorage helpers.
 */

const DATABASE_NAME = "sparcoon-editor";
const STORE_NAME = "environmentBlobs";
const DATABASE_VERSION = 1;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = (): void => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void => reject(request.error ?? new Error("indexedDB open failed"));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | undefined> {
  if (typeof indexedDB === "undefined") {
    return undefined;
  }
  try {
    const database = await openDatabase();
    return await new Promise<T | undefined>((resolve) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = run(transaction.objectStore(STORE_NAME));
      request.onsuccess = (): void => resolve(request.result);
      request.onerror = (): void => resolve(undefined);
      transaction.oncomplete = (): void => database.close();
    });
  } catch {
    return undefined;
  }
}

/** Stores `dataUrl` under `name`, replacing any existing entry. */
export async function putEnvironmentBlob(name: string, dataUrl: string): Promise<void> {
  await withStore("readwrite", (store) => store.put(dataUrl, name));
}

/** The persisted `dataUrl` for `name`, or `undefined` if absent/unavailable. */
export function getEnvironmentBlob(name: string): Promise<string | undefined> {
  return withStore<string>("readonly", (store) => store.get(name));
}

/** Drops the entry for `name`; a no-op if it was never stored. */
export async function deleteEnvironmentBlob(name: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(name));
}

/** Drops every stored HDRI blob (the library's "clear all"). */
export async function clearEnvironmentBlobs(): Promise<void> {
  await withStore("readwrite", (store) => store.clear());
}
