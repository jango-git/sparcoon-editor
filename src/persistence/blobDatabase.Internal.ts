/**
 * The editor's one IndexedDB database: asset payloads too large for `localStorage`'s
 * ~5-10MB per-origin quota, one object store per library, keyed by asset name. Never throws - a
 * blocked/unsupported/unresponsive IndexedDB (private mode, disabled, an open that never answers,
 * an older tab holding the previous version open) resolves to a failed request rather than
 * breaking the caller, mirroring `util/storage.ts`'s localStorage helpers.
 *
 * One connection serves the whole session: opened on the first request, kept open, and dropped -
 * to be opened afresh by the next request - when it fails, closes, or another page upgrades the
 * database.
 */

const DATABASE_NAME = "sparcoon-editor";
// 1: environmentBlobs. 2: + textureBlobs, meshBlobs.
const DATABASE_VERSION = 2;

/**
 * How long an open may take before it counts as failed. Some browsers' private modes leave
 * `indexedDB.open` pending forever; without a bound every save would wait on it (localStore.ts
 * writes the document once the payloads are stored), and none would ever land.
 */
const OPEN_TIMEOUT_MS = 3000;

/** HDRI `dataUrl`s (see assetBlobStore.ts). */
export const ENVIRONMENT_BLOB_STORE = "environmentBlobs";
/** Raster texture `dataUrl`s (see assetBlobStore.ts). */
export const TEXTURE_BLOB_STORE = "textureBlobs";
/** Mesh assets' baked geometry (see assetBlobStore.ts). */
export const MESH_BLOB_STORE = "meshBlobs";

const STORES = [ENVIRONMENT_BLOB_STORE, TEXTURE_BLOB_STORE, MESH_BLOB_STORE];

/** The session's connection while it is usable (or being opened); `undefined` opens a new one. */
let connection: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    let settled = false;
    const fail = (error: Error): void => {
      settled = true;
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("indexedDB open timed out")), OPEN_TIMEOUT_MS);
    request.onupgradeneeded = (): void => {
      for (const name of STORES) {
        if (!request.result.objectStoreNames.contains(name)) {
          request.result.createObjectStore(name);
        }
      }
    };
    request.onsuccess = (): void => {
      clearTimeout(timer);
      const database = request.result;
      if (settled) {
        // Opened after this attempt was given up (timed out or blocked): nobody holds it.
        database.close();
        return;
      }
      settled = true;
      database.onversionchange = (): void => {
        // A newer page upgrades the database: let it, and reopen on the next request.
        database.close();
        forget(database);
      };
      database.onclose = (): void => forget(database);
      resolve(database);
    };
    request.onerror = (): void => {
      clearTimeout(timer);
      fail(request.error ?? new Error("indexedDB open failed"));
    };
    // Another tab still holds version 1 open: fail this attempt (the caller degrades) instead of
    // waiting on it. Should it open after all, onsuccess closes it.
    request.onblocked = (): void => {
      clearTimeout(timer);
      fail(new Error("indexedDB upgrade blocked"));
    };
  });
}

/** Drops the cached connection if it is `database`'s, so the next request opens a new one. */
function forget(database: IDBDatabase): void {
  void connection?.then((current) => {
    if (current === database) {
      connection = undefined;
    }
  });
}

/** The session's connection, opening it on first use; a failed open is retried by the next call. */
function database(): Promise<IDBDatabase> {
  if (connection === undefined) {
    const opening = openDatabase();
    connection = opening;
    opening.catch(() => {
      if (connection === opening) {
        connection = undefined;
      }
    });
  }
  return connection;
}

/** The outcome of one request: `ok` once its transaction committed, with the request's result. */
export interface BlobRequestResult<T> {
  readonly ok: boolean;
  readonly result: T | undefined;
}

/**
 * Runs one request in its own transaction on `storeName`. `ok` is reported on the transaction's
 * `complete` (a write is durable then), not on the request's `success`.
 */
export async function runBlobRequest<T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<BlobRequestResult<T>> {
  const failed: BlobRequestResult<T> = { ok: false, result: undefined };
  if (typeof indexedDB === "undefined") {
    return failed;
  }
  let open: IDBDatabase | undefined;
  try {
    open = await database();
    const current = open;
    return await new Promise<BlobRequestResult<T>>((resolve) => {
      let result: T | undefined;
      const transaction = current.transaction(storeName, mode);
      const request = run(transaction.objectStore(storeName));
      request.onsuccess = (): void => {
        result = request.result;
      };
      transaction.oncomplete = (): void => resolve({ ok: true, result });
      transaction.onerror = (): void => resolve(failed);
      transaction.onabort = (): void => resolve(failed);
    });
  } catch {
    // Opening failed (already forgotten), or the connection is no longer usable (`transaction()`
    // throws then): the next request opens afresh.
    if (open !== undefined) {
      forget(open);
    }
    return failed;
  }
}
