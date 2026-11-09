/**
 * The asset libraries' heavy payloads - texture and HDRI bytes, mesh geometry - kept out of the
 * autosaved document: they quickly pass `localStorage`'s ~5-10MB per-origin quota, and then the
 * whole document write fails, not just the payloads. The document keeps each asset's metadata and
 * leaves its payload empty once the payload is confirmed stored here; on load it is filled back in.
 *
 * The libraries are synced from whatever the document holds at each save, so every path that adds,
 * replaces or removes an asset (upload, File > Open, a preset, the agent API, undo/redo) is covered
 * by this one mechanism - nothing else writes or deletes payloads. An asset whose payload is not
 * confirmed yet (IndexedDB unavailable) stays inline in the document, so a save never refers to a
 * payload that was not stored.
 */

import type {
  BakedMeshGeometry,
  EnvironmentAsset,
  MeshAsset,
  TextureAsset,
} from "../model/editorState";
import { isRecord } from "../util/guards";
import {
  ENVIRONMENT_BLOB_STORE,
  MESH_BLOB_STORE,
  runBlobRequest,
  TEXTURE_BLOB_STORE,
} from "./blobDatabase.Internal";

/** Where one library's payloads go. An IndexedDB store in the editor; an in-memory map in tests. */
export interface BlobBackend {
  /** Stores `payload` under `name`; `true` once it is durable. */
  put(name: string, payload: unknown): Promise<boolean>;
  /** The stored payload, or `undefined` if absent or unavailable. */
  get(name: string): Promise<unknown>;
  /** Drops `name`; `true` once done (also when it was never stored). */
  delete(name: string): Promise<boolean>;
}

/** One IndexedDB object store as a {@link BlobBackend}. */
export function indexedDbBlobBackend(storeName: string): BlobBackend {
  return {
    put: async (name, payload): Promise<boolean> =>
      (await runBlobRequest(storeName, "readwrite", (store) => store.put(payload, name))).ok,
    get: async (name): Promise<unknown> =>
      (await runBlobRequest<unknown>(storeName, "readonly", (store) => store.get(name))).result,
    delete: async (name): Promise<boolean> =>
      (await runBlobRequest(storeName, "readwrite", (store) => store.delete(name))).ok,
  };
}

/** Which field of a library's asset is its payload, and what an emptied one looks like. */
export interface BlobPayload<T extends { readonly name: string }, P> {
  /** The asset's payload, or `undefined` when it is empty (left out of the saved document). */
  read(asset: T): P | undefined;
  /** `asset` carrying `payload`. */
  withPayload(asset: T, payload: P): T;
  /** `asset` with its payload emptied, as the document saves it. */
  withoutPayload(asset: T): T;
  /** `raw` read back from the backend, if it is a payload of this library. */
  decode(raw: unknown): P | undefined;
}

/**
 * One library's payloads: which are known to be in the backend, and bringing the backend in line
 * with the document. A payload counts as stored only while the asset holds the very value that was
 * stored (assets are immutable, so an edit replaces it). Syncs run one after another, so a removal
 * from an older save can never land after a newer save stored the same name again.
 */
export class BlobSync<T extends { readonly name: string }, P> {
  /** name -> the exact payload confirmed stored under it (the same value the document holds). */
  private readonly stored = new Map<string, P>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly payload: BlobPayload<T, P>,
    private readonly backend: BlobBackend,
  ) {}

  /** `asset` as the document saves it: without its payload once that is stored. */
  public strip(asset: T): T {
    return this.isStored(asset) ? this.payload.withoutPayload(asset) : asset;
  }

  /**
   * Stores every payload not confirmed yet and drops the ones known here that the document no
   * longer has. Payloads this session never saw (no asset of its document named them) are never
   * dropped: another tab may still refer to them.
   */
  public sync(assets: readonly T[]): Promise<void> {
    const run = this.queue.then(() => this.syncNow(assets));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * `assets` with each emptied payload filled back in from the backend. An asset saved inline
   * (before its library moved here, or while IndexedDB was unavailable) keeps its payload and is
   * stored on the next save. One missing from both stays empty (the asset then fails to decode or
   * draws nothing).
   */
  public async hydrate(assets: readonly T[]): Promise<readonly T[]> {
    return Promise.all(
      assets.map(async (asset) => {
        if (this.payload.read(asset) !== undefined) {
          return asset;
        }
        const payload = this.payload.decode(await this.backend.get(asset.name));
        if (payload === undefined) {
          return asset;
        }
        this.stored.set(asset.name, payload);
        return this.payload.withPayload(asset, payload);
      }),
    );
  }

  private isStored(asset: T): boolean {
    const payload = this.payload.read(asset);
    return payload !== undefined && this.stored.get(asset.name) === payload;
  }

  private async syncNow(assets: readonly T[]): Promise<void> {
    const current = new Set<string>();
    for (const asset of assets) {
      current.add(asset.name);
      const payload = this.payload.read(asset);
      if (payload === undefined || this.isStored(asset)) {
        continue;
      }
      if (await this.backend.put(asset.name, payload)) {
        this.stored.set(asset.name, payload);
      }
    }
    for (const name of [...this.stored.keys()]) {
      if (!current.has(name) && (await this.backend.delete(name))) {
        this.stored.delete(name);
      }
    }
  }
}

/** A `dataUrl` payload (textures, HDRIs): emptied to `""`. */
export function dataUrlPayload<
  T extends { readonly name: string; readonly dataUrl: string },
>(): BlobPayload<T, string> {
  return {
    read: (asset) => (asset.dataUrl === "" ? undefined : asset.dataUrl),
    withPayload: (asset, dataUrl) => ({ ...asset, dataUrl }),
    withoutPayload: (asset) => ({ ...asset, dataUrl: "" }),
    decode: (raw) => (typeof raw === "string" ? raw : undefined),
  };
}

const EMPTY_GEOMETRY: BakedMeshGeometry = { position: [], normal: [], uv: [], index: [] };

function isNumberArray(raw: unknown): raw is readonly number[] {
  return Array.isArray(raw) && raw.every((value) => typeof value === "number");
}

/** A mesh asset's baked geometry: emptied to four empty arrays (a real mesh has vertices). */
export const MESH_GEOMETRY_PAYLOAD: BlobPayload<MeshAsset, BakedMeshGeometry> = {
  read: (asset) => (asset.geometry.position.length === 0 ? undefined : asset.geometry),
  withPayload: (asset, geometry) => ({ ...asset, geometry }),
  withoutPayload: (asset) => ({ ...asset, geometry: EMPTY_GEOMETRY }),
  decode: (raw) =>
    isRecord(raw) &&
    isNumberArray(raw["position"]) &&
    isNumberArray(raw["normal"]) &&
    isNumberArray(raw["uv"]) &&
    isNumberArray(raw["index"])
      ? {
          position: raw["position"],
          normal: raw["normal"],
          uv: raw["uv"],
          index: raw["index"],
        }
      : undefined,
};

/** The editor's libraries, shared by the autosave and the initial load (localStore.ts). */
export const textureBlobs = new BlobSync(
  dataUrlPayload<TextureAsset>(),
  indexedDbBlobBackend(TEXTURE_BLOB_STORE),
);
export const environmentBlobs = new BlobSync(
  dataUrlPayload<EnvironmentAsset>(),
  indexedDbBlobBackend(ENVIRONMENT_BLOB_STORE),
);
export const meshBlobs = new BlobSync(MESH_GEOMETRY_PAYLOAD, indexedDbBlobBackend(MESH_BLOB_STORE));
