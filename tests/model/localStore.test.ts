import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  EnvironmentAsset,
  MeshAsset,
  SceneAsset,
  SourceState,
  TextureAsset,
  VolumeAsset,
} from "../../src/model/editorState";
import type * as assetBlobStore from "../../src/persistence/assetBlobStore";
import { decodePayload, type StoredPayload } from "../../src/persistence/payloadCodec";

// The real sync logic over in-memory backends (one per library) that can be switched off. Each
// library's BlobSync remembers what it stored, so `renew` builds fresh ones for every test.
const backends = vi.hoisted(() => ({
  texture: new Map<string, unknown>(),
  environment: new Map<string, unknown>(),
  scene: new Map<string, unknown>(),
  mesh: new Map<string, unknown>(),
  volume: new Map<string, unknown>(),
  available: true,
  renew: (): void => undefined,
}));
vi.mock("../../src/persistence/assetBlobStore", async (importOriginal) => {
  const actual = await importOriginal<typeof assetBlobStore>();
  const memory = (data: Map<string, unknown>): assetBlobStore.BlobBackend => ({
    put: (name, payload) => {
      if (!backends.available) {
        return Promise.resolve(false);
      }
      data.set(name, payload);
      return Promise.resolve(true);
    },
    get: (name) => Promise.resolve(data.get(name)),
    delete: (name) => {
      data.delete(name);
      return Promise.resolve(true);
    },
  });
  const fresh = () => ({
    textureBlobs: new actual.BlobSync(actual.dataUrlPayload(), memory(backends.texture)),
    environmentBlobs: new actual.BlobSync(actual.bytesPayload(), memory(backends.environment)),
    sceneBlobs: new actual.BlobSync(actual.bytesPayload(), memory(backends.scene)),
    meshBlobs: new actual.BlobSync(actual.MESH_GEOMETRY_PAYLOAD, memory(backends.mesh)),
    volumeBlobs: new actual.BlobSync(actual.dataUrlPayload(), memory(backends.volume)),
  });
  let current = fresh();
  backends.renew = (): void => {
    current = fresh();
  };
  // localStore captures the libraries at load, so each stands in for whichever sync is current.
  const delegate = <K extends keyof typeof current>(key: K): (typeof current)[K] =>
    new Proxy(current[key], {
      get: (_target, property): unknown => {
        const sync = current[key];
        const value: unknown = Reflect.get(sync, property);
        return typeof value === "function" ? value.bind(sync) : value;
      },
    });
  return {
    ...actual,
    textureBlobs: delegate("textureBlobs"),
    environmentBlobs: delegate("environmentBlobs"),
    sceneBlobs: delegate("sceneBlobs"),
    meshBlobs: delegate("meshBlobs"),
    volumeBlobs: delegate("volumeBlobs"),
  };
});

const { hydrateSource, loadSource, saveSource } = await import("../../src/persistence/localStore");

const written = new Map<string, string>();
const storage = {
  setItem: (key: string, value: string): void => void written.set(key, value),
  getItem: (key: string): string | undefined => written.get(key),
};
(globalThis as unknown as { localStorage: typeof storage }).localStorage = storage;

function texture(name: string, dataUrl: string): TextureAsset {
  return { name, label: `${name}.png`, dataUrl, width: 4, height: 4 };
}

function environment(name: string, bytes: Uint8Array<ArrayBuffer>): EnvironmentAsset {
  return { name, label: `${name}.hdr`, bytes, byteSize: 3 };
}

function scene(name: string, bytes: Uint8Array<ArrayBuffer>): SceneAsset {
  return { name, label: `${name}.glb`, bytes, byteSize: 3 };
}

function volume(name: string, dataUrl: string): VolumeAsset {
  return {
    name,
    label: name,
    dataUrl,
    size: [2, 2, 2],
    boxMin: [-1, -1, -1],
    boxMax: [1, 1, 1],
    scale: 2,
    bias: -1,
  };
}

function mesh(name: string, position: readonly number[]): MeshAsset {
  return {
    name,
    label: `${name}.glb`,
    byteSize: 10,
    geometry: {
      position: Float32Array.from(position),
      normal: Float32Array.from([0, 1, 0]),
      uv: Float32Array.from([0, 0]),
      index: Uint32Array.from([0]),
    },
  };
}

const HDR = Uint8Array.from([1, 2, 3]);
const GLB = Uint8Array.from([4, 5, 6]);

/** Only the fields saveSource touches; the rest of the source is passed through untouched. */
function sourceWith(
  assets: readonly TextureAsset[],
  environments: readonly EnvironmentAsset[] = [],
  meshAssets: readonly MeshAsset[] = [],
  volumeAssets: readonly VolumeAsset[] = [],
  scenes: readonly SceneAsset[] = [],
): SourceState {
  return { assets, environments, scenes, meshAssets, volumeAssets } as unknown as SourceState;
}

interface StoredFileAsset {
  name: string;
  bytes: StoredPayload;
  byteSize: number;
}

interface SavedDocument {
  assets: TextureAsset[];
  environments: StoredFileAsset[];
  scenes: StoredFileAsset[];
  meshAssets: { name: string; byteSize: number; geometry: Record<string, StoredPayload> }[];
  volumeAssets: VolumeAsset[];
}

/** The saved document's source; it is stored in the project envelope. */
function saved(): SavedDocument {
  return (loadSource() as { source: SavedDocument }).source;
}

/** Lets the save's queued syncs and their follow-up write run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  backends.renew();
  written.clear();
  backends.texture.clear();
  backends.environment.clear();
  backends.scene.clear();
  backends.mesh.clear();
  backends.volume.clear();
  backends.available = true;
  storage.setItem = (key, value): void => void written.set(key, value);
});

describe("saveSource", () => {
  it("stores the bytes first and writes the document once, without them", async () => {
    const writes: string[] = [];
    storage.setItem = (key, value): void => {
      writes.push(value);
      written.set(key, value);
    };
    const rock = mesh("Rock", [1, 2, 3]);
    saveSource(
      sourceWith(
        [texture("tSmoke", "data:a")],
        [environment("sky", HDR)],
        [rock],
        [volume("Rock SDF", "data:v")],
        [scene("arena", GLB)],
      ),
    );
    expect(writes).toEqual([]);
    await settle();
    expect(backends.texture.get("tSmoke")).toBe("data:a");
    expect(backends.environment.get("sky")).toBe(HDR);
    expect(backends.scene.get("arena")).toBe(GLB);
    expect(backends.mesh.get("Rock")).toBe(rock.geometry);
    expect(saved().meshAssets[0]).toMatchObject({ name: "Rock", byteSize: 10 });
    expect(saved().meshAssets[0]?.geometry["position"]).toEqual({ encoding: "none", data: "" });
    expect(backends.volume.get("Rock SDF")).toBe("data:v");
    expect(saved().volumeAssets[0]).toMatchObject({ name: "Rock SDF", dataUrl: "", scale: 2 });
    expect(writes).toHaveLength(1);
    expect(writes[0]).not.toContain("data:a");
    expect(saved().assets[0]).toMatchObject({ name: "tSmoke", dataUrl: "", width: 4 });
    expect(saved().environments[0]).toMatchObject({
      name: "sky",
      bytes: { encoding: "none", data: "" },
      byteSize: 3,
    });
    expect(saved().scenes[0]).toMatchObject({
      name: "arena",
      bytes: { encoding: "none", data: "" },
    });
  });

  it("keeps bytes inline, plain, while IndexedDB is unavailable", async () => {
    backends.available = false;
    saveSource(
      sourceWith(
        [texture("tSmoke", "data:a")],
        [environment("sky", HDR)],
        [],
        [],
        [scene("arena", GLB)],
      ),
    );
    await settle();
    expect(saved().assets[0]?.dataUrl).toBe("data:a");
    expect(saved().environments[0]?.bytes.encoding).toBe("none");
    expect(await decodePayload(saved().environments[0].bytes)).toEqual(HDR);
    expect(await decodePayload(saved().scenes[0].bytes)).toEqual(GLB);
  });

  it("writes only the newest of overlapping saves", async () => {
    const writes: string[] = [];
    storage.setItem = (key, value): void => {
      writes.push(value);
      written.set(key, value);
    };
    saveSource(sourceWith([texture("tSmoke", "data:a")]));
    saveSource(sourceWith([texture("tFire", "data:b")]));
    await settle();
    expect(writes).toHaveLength(1);
    expect(saved().assets.map((asset) => asset.name)).toEqual(["tFire"]);
  });

  it("warns when the document cannot be written", async () => {
    storage.setItem = (): void => {
      throw new Error("QuotaExceededError");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    saveSource(sourceWith([texture("tBig", "data:big")]));
    await settle();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("hydrateSource", () => {
  it("fills every library's payloads back in", async () => {
    backends.texture.set("tSmoke", "data:a");
    backends.environment.set("sky", HDR);
    backends.scene.set("arena", GLB);
    backends.mesh.set("Rock", mesh("Rock", [1, 2, 3]).geometry);
    backends.volume.set("Rock SDF", "data:v");
    const source = await hydrateSource(
      sourceWith(
        [texture("tSmoke", "")],
        [environment("sky", new Uint8Array())],
        [mesh("Rock", [])],
        [volume("Rock SDF", "")],
        [scene("arena", new Uint8Array())],
      ),
    );
    expect(source.assets[0]?.dataUrl).toBe("data:a");
    expect(source.environments[0]?.bytes).toBe(HDR);
    expect(source.scenes[0]?.bytes).toBe(GLB);
    expect(source.meshAssets[0]?.geometry.position).toEqual(Float32Array.from([1, 2, 3]));
    expect(source.volumeAssets[0]?.dataUrl).toBe("data:v");
  });

  it("reads payloads stored in an older form and stores them again in the current one", async () => {
    backends.environment.set("sky", "data:application/octet-stream;base64,AQID");
    backends.mesh.set("Rock", { position: [1, 2, 3], normal: [0, 1, 0], uv: [0, 0], index: [0] });
    const source = await hydrateSource(
      sourceWith([], [environment("sky", new Uint8Array())], [mesh("Rock", [])]),
    );
    expect(source.environments[0]?.bytes).toEqual(HDR);
    expect(source.meshAssets[0]?.geometry.index).toEqual(Uint32Array.from([0]));
    saveSource(source);
    await settle();
    expect(backends.environment.get("sky")).toEqual(HDR);
    expect(backends.mesh.get("Rock")).toBe(source.meshAssets[0]?.geometry);
  });
});
