import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  EnvironmentAsset,
  MeshAsset,
  SourceState,
  TextureAsset,
} from "../../src/model/editorState";
import type * as assetBlobStore from "../../src/persistence/assetBlobStore";

// The real sync logic over in-memory backends (one per library) that can be switched off. Each
// library's BlobSync remembers what it stored, so `renew` builds fresh ones for every test.
const backends = vi.hoisted(() => ({
  texture: new Map<string, unknown>(),
  environment: new Map<string, unknown>(),
  mesh: new Map<string, unknown>(),
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
    environmentBlobs: new actual.BlobSync(actual.dataUrlPayload(), memory(backends.environment)),
    meshBlobs: new actual.BlobSync(actual.MESH_GEOMETRY_PAYLOAD, memory(backends.mesh)),
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
    meshBlobs: delegate("meshBlobs"),
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

function environment(name: string, dataUrl: string): EnvironmentAsset {
  return { name, label: `${name}.hdr`, dataUrl, byteSize: 3 };
}

function mesh(name: string, position: readonly number[]): MeshAsset {
  return {
    name,
    label: `${name}.glb`,
    byteSize: 10,
    geometry: { position, normal: [0, 1, 0], uv: [0, 0], index: [0] },
  };
}

/** Only the fields saveSource touches; the rest of the source is passed through untouched. */
function sourceWith(
  assets: readonly TextureAsset[],
  environments: readonly EnvironmentAsset[] = [],
  meshAssets: readonly MeshAsset[] = [],
): SourceState {
  return { assets, environments, meshAssets } as unknown as SourceState;
}

interface SavedDocument {
  assets: TextureAsset[];
  environments: EnvironmentAsset[];
  meshAssets: MeshAsset[];
}

function saved(): SavedDocument {
  return loadSource() as SavedDocument;
}

/** Lets the save's queued syncs and their follow-up write run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  backends.renew();
  written.clear();
  backends.texture.clear();
  backends.environment.clear();
  backends.mesh.clear();
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
      sourceWith([texture("tSmoke", "data:a")], [environment("studio", "data:h")], [rock]),
    );
    expect(writes).toEqual([]);
    await settle();
    expect(backends.texture.get("tSmoke")).toBe("data:a");
    expect(backends.environment.get("studio")).toBe("data:h");
    expect(backends.mesh.get("Rock")).toBe(rock.geometry);
    expect(saved().meshAssets[0]).toMatchObject({ name: "Rock", byteSize: 10 });
    expect(saved().meshAssets[0]?.geometry.position).toEqual([]);
    expect(writes).toHaveLength(1);
    expect(writes[0]).not.toContain("data:a");
    expect(saved().assets[0]).toMatchObject({ name: "tSmoke", dataUrl: "", width: 4 });
    expect(saved().environments[0]).toMatchObject({ name: "studio", dataUrl: "", byteSize: 3 });
  });

  it("keeps bytes inline while IndexedDB is unavailable", async () => {
    backends.available = false;
    saveSource(sourceWith([texture("tSmoke", "data:a")], [environment("studio", "data:h")]));
    await settle();
    expect(saved().assets[0]?.dataUrl).toBe("data:a");
    expect(saved().environments[0]?.dataUrl).toBe("data:h");
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
    backends.environment.set("studio", "data:h");
    backends.mesh.set("Rock", { position: [1, 2, 3], normal: [0, 1, 0], uv: [0, 0], index: [0] });
    const source = await hydrateSource(
      sourceWith([texture("tSmoke", "")], [environment("studio", "")], [mesh("Rock", [])]),
    );
    expect(source.assets[0]?.dataUrl).toBe("data:a");
    expect(source.environments[0]?.dataUrl).toBe("data:h");
    expect(source.meshAssets[0]?.geometry.position).toEqual([1, 2, 3]);
  });
});
