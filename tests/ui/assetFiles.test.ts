import { describe, expect, it, vi } from "vitest";

import type { BakedMeshGeometry, SourceState } from "../../src/model/editorState";
import { createInitialState } from "../../src/model/editorState";
import { readZip } from "../helpers/zip";

// Three's GLTFExporter needs a browser FileReader. The GLB here only stands for "the mesh's bytes".
vi.mock("../../src/render/meshGeometryBaking", () => ({
  encodeMeshGlb: (baked: BakedMeshGeometry): Promise<ArrayBuffer> =>
    Promise.resolve(Float32Array.from(baked.position).buffer),
}));

// Imported after the mock so the zip picks up the mocked encoder.
const { libraryZip } = await import("../../src/ui/assetFiles");

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const pngBytes = Uint8Array.from(atob("iVBORw0KGgo="), (character) => character.charCodeAt(0));

const geometry: BakedMeshGeometry = { position: [0, 1, 2], normal: [], uv: [], index: [] };

function library(): SourceState {
  const base = createInitialState().source;
  return {
    ...base,
    assets: [
      { name: "spark", label: "spark.png", dataUrl: PNG, width: 1, height: 1 },
      { name: "spark_2", label: "Spark.png", dataUrl: PNG, width: 1, height: 1 },
    ],
    environments: [{ name: "sky", label: "sky.hdr", dataUrl: PNG, byteSize: 8 }],
    meshAssets: [{ name: "rock", label: "Rock", geometry, byteSize: 12 }],
    volumeAssets: [
      {
        name: "rock_sdf",
        label: "Rock SDF",
        dataUrl: PNG,
        size: [8, 4, 2],
        boxMin: [0, 0, 0],
        boxMax: [1, 1, 1],
        scale: 1,
        bias: 0,
      },
    ],
  };
}

describe("libraryZip", () => {
  it("holds the images, meshes and volumes under their labels, without HDRIs", async () => {
    const entries = readZip(await libraryZip(library()));
    expect(entries.map((entry) => entry.name)).toEqual([
      "spark.png",
      "Spark 2.png",
      "Rock.glb",
      "Rock SDF 8x4x2.png",
    ]);
    expect(entries[0]?.bytes).toEqual(pngBytes);
    expect(entries[3]?.bytes).toEqual(pngBytes);
    expect(entries[2]?.bytes).toEqual(new Uint8Array(Float32Array.of(0, 1, 2).buffer));
  });
});
