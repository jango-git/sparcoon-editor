import { describe, expect, it } from "vitest";

import type { MeshAsset, TextureAsset } from "../../src/model/editorState";
import type { BlobBackend } from "../../src/persistence/assetBlobStore";
import {
  BlobSync,
  dataUrlPayload,
  MESH_GEOMETRY_PAYLOAD,
} from "../../src/persistence/assetBlobStore";

/** An in-memory backend that records every call; `failPuts` makes stores fail (no IndexedDB). */
class MemoryBackend implements BlobBackend {
  public readonly data = new Map<string, unknown>();
  public readonly calls: string[] = [];
  public failPuts = false;

  public put(name: string, payload: unknown): Promise<boolean> {
    this.calls.push(`put ${name}`);
    if (this.failPuts) {
      return Promise.resolve(false);
    }
    this.data.set(name, payload);
    return Promise.resolve(true);
  }

  public get(name: string): Promise<unknown> {
    return Promise.resolve(this.data.get(name));
  }

  public delete(name: string): Promise<boolean> {
    this.calls.push(`delete ${name}`);
    this.data.delete(name);
    return Promise.resolve(true);
  }
}

function texture(name: string, dataUrl: string): TextureAsset {
  return { name, label: `${name}.png`, dataUrl, width: 4, height: 4 };
}

function textureSync(backend: BlobBackend): BlobSync<TextureAsset, string> {
  return new BlobSync(dataUrlPayload<TextureAsset>(), backend);
}

/** Whether the document may leave `asset`'s bytes out (they are confirmed stored). */
function isStored(blobs: BlobSync<TextureAsset, string>, asset: TextureAsset): boolean {
  return asset.dataUrl !== "" && blobs.strip(asset).dataUrl === "";
}

describe("BlobSync", () => {
  it("stores new bytes once and then reports them as stored", async () => {
    const backend = new MemoryBackend();
    const blobs = textureSync(backend);
    const smoke = texture("tSmoke", "data:image/png;base64,AAAA");
    expect(isStored(blobs, smoke)).toBe(false);

    await blobs.sync([smoke]);
    expect(isStored(blobs, smoke)).toBe(true);
    expect(backend.data.get("tSmoke")).toBe(smoke.dataUrl);

    // Nothing new: no second write.
    await blobs.sync([smoke]);
    expect(backend.calls).toEqual(["put tSmoke"]);
  });

  it("stores again when a texture's bytes change under the same name", async () => {
    const backend = new MemoryBackend();
    const blobs = textureSync(backend);
    await blobs.sync([texture("tSmoke", "data:a")]);
    const replaced = texture("tSmoke", "data:b");
    expect(isStored(blobs, replaced)).toBe(false);
    await blobs.sync([replaced]);
    expect(backend.data.get("tSmoke")).toBe("data:b");
  });

  it("keeps bytes inline when the backend cannot store them", async () => {
    const backend = new MemoryBackend();
    backend.failPuts = true;
    const blobs = textureSync(backend);
    const smoke = texture("tSmoke", "data:a");
    await blobs.sync([smoke]);
    expect(isStored(blobs, smoke)).toBe(false);
  });

  it("drops bytes it stored once the document no longer has the texture", async () => {
    const backend = new MemoryBackend();
    const blobs = textureSync(backend);
    const smoke = texture("tSmoke", "data:a");
    await blobs.sync([smoke, texture("tFire", "data:b")]);
    await blobs.sync([smoke]);
    expect([...backend.data.keys()]).toEqual(["tSmoke"]);
  });

  it("never drops bytes only another session stored", async () => {
    const backend = new MemoryBackend();
    backend.data.set("tOtherTab", "data:x");
    const blobs = textureSync(backend);
    await blobs.sync([texture("tSmoke", "data:a")]);
    expect(backend.data.get("tOtherTab")).toBe("data:x");
  });

  it("brings back a removed texture (undo) by storing it again", async () => {
    const backend = new MemoryBackend();
    const blobs = textureSync(backend);
    const smoke = texture("tSmoke", "data:a");
    // Removal and restore queued back to back, as two quick autosaves would.
    const removed = blobs.sync([]);
    const restored = blobs.sync([smoke]);
    await Promise.all([removed, restored]);
    expect(backend.data.get("tSmoke")).toBe("data:a");
    expect(isStored(blobs, smoke)).toBe(true);
  });

  it("strips stored bytes only, keeping the rest of the asset", async () => {
    const blobs = textureSync(new MemoryBackend());
    const smoke = texture("tSmoke", "data:a");
    expect(blobs.strip(smoke)).toBe(smoke);
    await blobs.sync([smoke]);
    expect(blobs.strip(smoke)).toEqual({ ...smoke, dataUrl: "" });
  });

  it("drops bytes of a hydrated asset once the document removes it", async () => {
    const backend = new MemoryBackend();
    backend.data.set("tSmoke", "data:a");
    const blobs = textureSync(backend);
    await blobs.hydrate([texture("tSmoke", "")]);
    await blobs.sync([]);
    expect(backend.data.has("tSmoke")).toBe(false);
  });

  it("hydrates emptied bytes from the backend and leaves inline or missing ones as they are", async () => {
    const backend = new MemoryBackend();
    backend.data.set("tSmoke", "data:a");
    const blobs = textureSync(backend);
    const hydrated = await blobs.hydrate([
      texture("tSmoke", ""),
      texture("tLegacy", "data:inline"),
      texture("tGone", ""),
    ]);
    const [smoke, legacy, missing] = hydrated.map((asset) => ({
      dataUrl: asset.dataUrl,
      stored: isStored(blobs, asset),
    }));
    expect(smoke).toEqual({ dataUrl: "data:a", stored: true });
    expect(legacy).toEqual({ dataUrl: "data:inline", stored: false });
    expect(missing).toEqual({ dataUrl: "", stored: false });
  });
});

function mesh(name: string, position: readonly number[]): MeshAsset {
  return {
    name,
    label: `${name}.glb`,
    byteSize: 10,
    geometry: { position, normal: [0, 1, 0], uv: [0, 0], index: [0] },
  };
}

describe("BlobSync with mesh geometry", () => {
  it("stores the geometry and saves the asset with empty arrays", async () => {
    const backend = new MemoryBackend();
    const blobs = new BlobSync(MESH_GEOMETRY_PAYLOAD, backend);
    const rock = mesh("Rock", [1, 2, 3]);
    expect(blobs.strip(rock)).toBe(rock);
    await blobs.sync([rock]);
    expect(backend.data.get("Rock")).toBe(rock.geometry);
    expect(blobs.strip(rock)).toEqual({
      ...rock,
      geometry: { position: [], normal: [], uv: [], index: [] },
    });
  });

  it("hydrates emptied geometry and ignores a malformed stored value", async () => {
    const backend = new MemoryBackend();
    backend.data.set("Rock", { position: [1, 2, 3], normal: [0, 1, 0], uv: [0, 0], index: [0] });
    backend.data.set("Broken", { position: "nope" });
    const blobs = new BlobSync(MESH_GEOMETRY_PAYLOAD, backend);
    const empty = mesh("Rock", []);
    const hydrated = await blobs.hydrate([empty, mesh("Broken", [])]);
    // Filled back in, and known as stored (the document leaves it out again).
    expect(hydrated.map((asset) => asset.geometry.position)).toEqual([[1, 2, 3], []]);
    expect(hydrated.map((asset) => blobs.strip(asset).geometry.position)).toEqual([[], []]);
  });
});
