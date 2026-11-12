import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAssetsApi } from "../../src/agent/assets";
import { createInitialState } from "../../src/model/editorState";
import { SignalBus } from "../../src/model/signals";
import { Store } from "../../src/model/store";

/** The browser file plumbing ingestion reads through, over node's own File/Blob. */
class DataTransferStub {
  public readonly files: File[] = [];
  public readonly items = { add: (file: File): void => void this.files.push(file) };
}

class FileReaderStub {
  public result: string | undefined;
  public error: Error | undefined;
  public onload: (() => void) | undefined;
  public onerror: (() => void) | undefined;
  public readAsDataURL(file: File): void {
    void file.arrayBuffer().then((bytes) => {
      this.result = `data:${file.type};base64,${Buffer.from(bytes).toString("base64")}`;
      this.onload?.();
    });
  }
}

/** Every image decodes, at 8x4. */
class ImageStub {
  public readonly naturalWidth = 8;
  public readonly naturalHeight = 4;
  public onload: (() => void) | undefined;
  public onerror: (() => void) | undefined;
  public set src(_url: string) {
    queueMicrotask(() => this.onload?.());
  }
}

/** What three's FileLoader reports a fetch's progress with. */
class ProgressEventStub {
  public constructor(
    public readonly type: string,
    init: object = {},
  ) {
    Object.assign(this, init);
  }
}

/** A one-triangle glTF named `Tri`, its buffer inline. */
function triangleGltf(): string {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const buffer = Buffer.from(positions.buffer).toString("base64");
  return JSON.stringify({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ name: "Tri", primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
    ],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    buffers: [{ byteLength: 36, uri: `data:application/octet-stream;base64,${buffer}` }],
  });
}

function assets(): { store: Store; api: ReturnType<typeof createAssetsApi> } {
  const store = new Store(createInitialState(), new SignalBus());
  return { store, api: createAssetsApi(store) };
}

beforeEach(() => {
  vi.stubGlobal("DataTransfer", DataTransferStub);
  vi.stubGlobal("FileReader", FileReaderStub);
  vi.stubGlobal("Image", ImageStub);
  vi.stubGlobal("ProgressEvent", ProgressEventStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("agent assets: add", () => {
  it("routes a file to its library by extension", async () => {
    const { api } = assets();
    expect(await api.add("spark.PNG", new Uint8Array([1, 2, 3]))).toEqual([
      { kind: "texture", name: "spark" },
    ]);
    expect(await api.add("studio.hdr", "AAEC")).toEqual([{ kind: "environment", name: "studio" }]);
    expect(await api.add("shape.gltf", new TextEncoder().encode(triangleGltf()))).toEqual([
      { kind: "mesh", name: "Tri" },
    ]);
    const view = api.list();
    expect(view.textures).toEqual([{ name: "spark", label: "spark.PNG", width: 8, height: 4 }]);
    expect(view.environments).toEqual([{ name: "studio", label: "studio.hdr", byteSize: 3 }]);
    expect(view.meshes).toEqual([{ name: "Tri", label: "Tri", vertexCount: 3 }]);
  });

  it("names a texture as a shader identifier, numbered on a clash", async () => {
    const { api } = assets();
    expect(await api.add("T_Sparkle.png", "data:,x")).toEqual([
      { kind: "texture", name: "tSparkle" },
    ]);
    expect(await api.add("T_Sparkle.png", "data:,x")).toEqual([
      { kind: "texture", name: "tSparkle2" },
    ]);
    expect(await api.add("3-d.png", "data:,x")).toEqual([{ kind: "texture", name: "texture3d" }]);
  });

  it("rejects a file that yields no asset, and data it cannot read", async () => {
    const { api } = assets();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(api.add("notes.txt", "data:,x")).rejects.toThrow(/rejected/);
    await expect(api.add("broken.glb", new Uint8Array([1, 2, 3]))).rejects.toThrow(/rejected/);
    await expect(api.add("spark.png", "not base64!")).rejects.toThrow(/invalid_argument/);
    await expect(api.add("", "data:,x")).rejects.toThrow(/invalid_argument/);
  });
});

describe("agent assets: remove and environment", () => {
  it("removes an asset by kind and name, and refuses one it does not have", async () => {
    const { api } = assets();
    await api.add("spark.png", "data:,x");
    expect(() => api.remove("mesh", "spark")).toThrow(/not_found/);
    api.remove("texture", "spark");
    expect(api.list().textures).toEqual([]);
    expect(() => api.remove("texture", "spark")).toThrow(/not_found/);
  });

  it("lights the viewport with a known environment, and clears it again", async () => {
    const { store, api } = assets();
    await api.add("studio.hdr", "data:,x");
    api.setEnvironment("studio");
    expect(store.getSource().activeEnvironmentName).toBe("studio");
    expect(() => api.setEnvironment("missing")).toThrow(/not_found/);
    expect(store.getSource().activeEnvironmentName).toBe("studio");
    api.setEnvironment(undefined);
    expect(api.list().activeEnvironment).toBeUndefined();
  });
});
