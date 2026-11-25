import { describe, expect, it } from "vitest";

import { createInitialState } from "../../src/model/editorState";
import { wrapProject } from "../../src/persistence/projectEnvelope";
import { loadedProject } from "../helpers/loadedProject";

/** A format-2 project file: an HDRI as a data URL, a mesh as number arrays. */
function formatTwo(): string {
  const source = createInitialState().source;
  return JSON.stringify({
    ...wrapProject({
      ...source,
      environments: [
        {
          name: "sky",
          label: "sky.hdr",
          dataUrl: "data:application/octet-stream;base64,AQID",
          byteSize: 3,
        },
        { name: "notData", label: "x.hdr", dataUrl: "sky.hdr", byteSize: 3 },
      ],
      meshAssets: [
        {
          name: "tri",
          label: "tri",
          geometry: {
            position: [0, 0, 0, 1, 0, 0, 0, 1, "x"],
            normal: [0, 0, 1, 0, 0, 1, 0, 0, 1],
            uv: [0, 0, 1, 0, 0, 1],
            index: [0, 1, 2],
          },
          byteSize: 108,
        },
      ],
    }),
    version: 2,
  });
}

describe("format 2 -> 3", () => {
  it("reads an HDRI's data URL as its bytes and a mesh's arrays as typed arrays", async () => {
    const source = await loadedProject(formatTwo());
    expect(source?.environments).toEqual([
      { name: "sky", label: "sky.hdr", bytes: Uint8Array.from([1, 2, 3]), byteSize: 3 },
    ]);
    expect(source?.meshAssets[0]?.geometry).toEqual({
      position: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normal: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uv: Float32Array.from([0, 0, 1, 0, 0, 1]),
      index: Uint32Array.from([0, 1, 2]),
    });
    expect(source?.scenes).toEqual([]);
    expect(source?.activeSceneName).toBe("studio");
  });
});
