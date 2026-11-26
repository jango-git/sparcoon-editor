import { describe, expect, it } from "vitest";

import { createInitialState, type SourceState } from "../../src/model/editorState";
import { DEFAULT_VIEWPORT_VIEW, type ViewportView } from "../../src/model/viewportView";
import { plainPayload } from "../../src/persistence/payloadCodec";
import { wrapProject } from "../../src/persistence/projectEnvelope";
import { deserializeProject, serializeProject } from "../../src/persistence/projectFile";
import { loadedProject } from "../helpers/loadedProject";

/** A tiny opaque data URL - stands in for a base64 asset that must survive the round-trip. */
const PIXEL_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Three bytes standing in for a file's payload. */
const BYTES = Uint8Array.from([1, 2, 3]);

/** `source` as a format-1 project file, the format the renames were made in. */
/** A Timeline Value node declaring `name`, so the tracks of that name survive the load. */
function timelineValue(name: string) {
  return {
    id: "tv",
    type: "timeline-value",
    parameters: { name, value: 1 },
    position: { x: 0, y: 0 },
  };
}

function formatOne(source: SourceState): string {
  return JSON.stringify({ ...wrapProject(source), version: 1 });
}

function sourceWithAsset(): SourceState {
  const base = createInitialState().source;
  return {
    ...base,
    name: "my-effect",
    assets: [{ name: "spark", label: "spark.png", dataUrl: PIXEL_DATA_URL, width: 1, height: 1 }],
  };
}

describe("projectFile: serialize/deserialize round-trip", () => {
  it("round-trips the whole document unchanged, its base64 assets included", async () => {
    const source = sourceWithAsset();
    const restored = await loadedProject(await serializeProject(source, DEFAULT_VIEWPORT_VIEW));
    expect(restored).toEqual(source);
    expect(restored?.assets[0]?.dataUrl).toBe(PIXEL_DATA_URL);
  });

  it("loads a project saved before the loop setting existed as looping, and keeps an explicit off", async () => {
    const source = createInitialState().source;
    const legacy = JSON.parse(await serializeProject(source, DEFAULT_VIEWPORT_VIEW)) as {
      source: { timeline: Record<string, unknown> };
    };
    delete legacy.source.timeline["loop"];
    expect((await loadedProject(JSON.stringify(legacy)))?.timeline.loop).toBe(true);

    const once = { ...source, timeline: { ...source.timeline, loop: false } };
    expect(
      (await loadedProject(await serializeProject(once, DEFAULT_VIEWPORT_VIEW)))?.timeline.loop,
    ).toBe(false);
  });

  it("keeps an emitter's editor-only events flag, and leaves it off when absent", async () => {
    const base = createInitialState().source;
    const [emitter, ...rest] = base.scene.emitters;
    const live: SourceState = {
      ...base,
      scene: { ...base.scene, emitters: [{ ...emitter, liveEvents: true }, ...rest] },
    };
    expect(
      (await loadedProject(await serializeProject(live, DEFAULT_VIEWPORT_VIEW)))?.scene.emitters[0]
        ?.liveEvents,
    ).toBe(true);
    const restored = (await loadedProject(await serializeProject(base, DEFAULT_VIEWPORT_VIEW)))
      ?.scene.emitters[0];
    expect(restored !== undefined && "liveEvents" in restored).toBe(false);
  });

  it("rejects unreadable or non-project text", async () => {
    expect(await loadedProject("not json {{")).toBeUndefined();
    expect(await loadedProject(JSON.stringify({ hello: "world" }))).toBeUndefined();
    expect(
      await loadedProject(JSON.stringify({ format: "sparcoon-project", version: 1 })),
    ).toBeUndefined();
  });

  it("preserves saved palette swatches", async () => {
    const base = createInitialState().source;
    const source: SourceState = {
      ...base,
      palette: [{ name: "swatch_1", label: "Accent", color: [1, 0.4, 0, 1] }],
    };
    const restored = await loadedProject(await serializeProject(source, DEFAULT_VIEWPORT_VIEW));
    expect(restored?.palette).toEqual(source.palette);
  });

  it("tolerates a bare source with no envelope", async () => {
    const source = sourceWithAsset();
    expect((await loadedProject(JSON.stringify(source)))?.name).toBe("my-effect");
  });

  it("seeds the id counter from the raw document before backfilling a missing keyframe id", async () => {
    // A legacy/malformed keyframe with no `id` sits alongside one already named "key_1" - the
    // lowest id a fresh session's counter would mint. If normalization backfills the missing id
    // before the counter has seen "key_1" (seeding only after normalizeSource returns), the
    // backfill collides with it - two distinct keyframes on the same track sharing one id.
    const raw = {
      scene: {
        emitters: [
          {
            id: "emitter_1",
            behaviorGraph: { nodes: { tv: timelineValue("myValue") }, connections: [] },
            tracks: [
              {
                name: "myValue",
                keys: [
                  { id: "key_1", time: 0, value: 1 },
                  { time: 1, value: 2 }, // no id - must be backfilled
                ],
              },
            ],
          },
        ],
      },
    };

    const restored = await loadedProject(JSON.stringify(raw));
    const keys = restored?.scene.emitters[0]?.tracks[0]?.keys;
    expect(keys).toHaveLength(2);
    const ids = keys?.map((key) => key.id) ?? [];
    expect(ids).toContain("key_1");
    expect(new Set(ids).size).toBe(2); // the backfilled id didn't collide with "key_1"
  });
});

describe("projectFile: format", () => {
  it("names the format's number and the editor that saved it", async () => {
    const file = JSON.parse(
      await serializeProject(createInitialState().source, DEFAULT_VIEWPORT_VIEW),
    ) as Record<string, unknown>;
    expect(file["format"]).toBe("sparcoon-project");
    expect(file["version"]).toBe(3);
    expect(file["editor"]).toBe(SPARCOON_EDITOR_VERSION);
  });

  it("refuses a project in a later format, naming the editor that saved it", async () => {
    const file = JSON.parse(
      await serializeProject(createInitialState().source, DEFAULT_VIEWPORT_VIEW),
    ) as object;
    expect(
      await deserializeProject(JSON.stringify({ ...file, version: 4, editor: "9.0.0" })),
    ).toEqual({
      kind: "newer",
      editor: "9.0.0",
    });
  });

  it("reads a project without a number, or with one that is not a positive integer, as format 1", async () => {
    const file = JSON.parse(
      await serializeProject(createInitialState().source, DEFAULT_VIEWPORT_VIEW),
    ) as object;
    for (const version of [undefined, "2", 1.5, 0, -3]) {
      expect((await deserializeProject(JSON.stringify({ ...file, version }))).kind).toBe("loaded");
    }
  });

  it("round-trips the viewport camera beside the document", async () => {
    const camera: ViewportView = { position: [1, 2, 3], target: [0, 0.5, 0], fov: 35 };
    const read = await deserializeProject(
      await serializeProject(createInitialState().source, camera),
    );
    expect(read.kind === "loaded" ? read.camera : undefined).toEqual(camera);
  });

  it("reads a project without a camera, or with a damaged one, as having none", async () => {
    const file = JSON.parse(
      await serializeProject(createInitialState().source, DEFAULT_VIEWPORT_VIEW),
    ) as Record<string, unknown>;
    for (const camera of [
      undefined,
      { position: [0, 1], target: [0, 0, 0], fov: 50 },
      { fov: 0 },
    ]) {
      const read = await deserializeProject(JSON.stringify({ ...file, camera }));
      expect(read.kind).toBe("loaded");
      expect(read.kind === "loaded" ? read.camera : "missing").toBeUndefined();
    }
  });
});

describe("projectFile: renamed nodes and inputs", () => {
  it("loads a spawn-cylinder saved with `length` as a random-cylinder-point with `height`, value and wire alike", async () => {
    const base = createInitialState().source;
    const [emitter] = base.scene.emitters;
    const graph = emitter.behaviorGraph;
    const saved: SourceState = {
      ...base,
      scene: {
        ...base.scene,
        emitters: [
          {
            ...emitter,
            behaviorGraph: {
              ...graph,
              nodes: {
                ...graph.nodes,
                cyl: {
                  id: "cyl",
                  type: "spawn-cylinder",
                  parameters: { radius: 2, length: 3 },
                  position: { x: 0, y: 0 },
                },
                len: {
                  id: "len",
                  type: "float",
                  parameters: { value: 5 },
                  position: { x: 0, y: 0 },
                },
              },
              connections: [
                ...graph.connections,
                {
                  id: "wire",
                  from: { nodeId: "len", socketKey: "value" },
                  to: { nodeId: "cyl", socketKey: "length" },
                },
              ],
            },
          },
          ...base.scene.emitters.slice(1),
        ],
      },
    };

    const loaded = (await loadedProject(formatOne(saved)))?.scene.emitters[0].behaviorGraph;

    expect(loaded?.nodes["cyl"]?.type).toBe("random-cylinder-point");
    expect(loaded?.nodes["cyl"]?.parameters).toEqual({ radius: 2, height: 3 });
    expect(loaded?.connections.find((connection) => connection.id === "wire")?.to).toEqual({
      nodeId: "cyl",
      socketKey: "height",
    });
    // Nothing else is touched.
    expect(loaded?.nodes["len"]?.parameters).toEqual({ value: 5 });
  });
});

describe("projectFile: renamed node outputs", () => {
  it("loads an animated-texture's old uvPrevious / uvCurrent wires as uvFrame / uvNext", async () => {
    const base = createInitialState().source;
    const [emitter] = base.scene.emitters;
    const graph = emitter.renderGraph;
    const saved: SourceState = {
      ...base,
      scene: {
        ...base.scene,
        emitters: [
          {
            ...emitter,
            renderGraph: {
              ...graph,
              nodes: {
                ...graph.nodes,
                flip: {
                  id: "flip",
                  type: "animated-texture",
                  parameters: { columns: 4, rows: 4 },
                  position: { x: 0, y: 0 },
                },
                len: { id: "len", type: "length", parameters: {}, position: { x: 0, y: 0 } },
                len2: { id: "len2", type: "length", parameters: {}, position: { x: 0, y: 0 } },
              },
              connections: [
                ...graph.connections,
                // Wires as an old file holds them, under the outputs' old names
                {
                  id: "wire",
                  from: { nodeId: "flip", socketKey: "uvCurrent" },
                  to: { nodeId: "len", socketKey: "v" },
                },
                {
                  id: "wire2",
                  from: { nodeId: "flip", socketKey: "uvPrevious" },
                  to: { nodeId: "len2", socketKey: "v" },
                },
              ],
              outputBindings: [
                ...graph.outputBindings.filter((binding) => binding.slot !== "alphaThreshold"),
                { slot: "alphaThreshold", from: { nodeId: "flip", socketKey: "factor" } },
              ],
            },
          },
          ...base.scene.emitters.slice(1),
        ],
      },
    };
    const loaded = (await loadedProject(formatOne(saved)))?.scene.emitters[0].renderGraph;

    const fromOf = (id: string) => loaded?.connections.find((c) => c.id === id)?.from;
    expect(fromOf("wire")).toEqual({ nodeId: "flip", socketKey: "uvNext" });
    expect(fromOf("wire2")).toEqual({ nodeId: "flip", socketKey: "uvFrame" });
    // An output that kept its name is left as it was
    expect(
      loaded?.outputBindings.find((binding) => binding.slot === "alphaThreshold")?.from,
    ).toEqual({ nodeId: "flip", socketKey: "factor" });
  });
});

describe("projectFile: key curves", () => {
  it("keeps a key's curve, and drops one it does not know (the key then reads linear)", async () => {
    const base = createInitialState().source;
    const [emitter] = base.scene.emitters;
    const source: SourceState = {
      ...base,
      scene: {
        ...base.scene,
        emitters: [
          {
            ...emitter,
            renderGraph: {
              ...emitter.renderGraph,
              nodes: { ...emitter.renderGraph.nodes, tv: timelineValue("glow") },
            },
            tracks: [
              {
                name: "glow",
                keys: [
                  { id: "k1", time: 0, value: 0, ease: "inOut" },
                  { id: "k2", time: 1, value: 1, ease: "bounce" as never },
                ],
              },
            ],
          },
          ...base.scene.emitters.slice(1),
        ],
      },
    };
    const keys = (await loadedProject(await serializeProject(source, DEFAULT_VIEWPORT_VIEW)))?.scene
      .emitters[0].tracks[0]?.keys;
    expect(keys?.[0]).toEqual({ id: "k1", time: 0, value: 0, ease: "inOut" });
    expect(keys?.[1]).toEqual({ id: "k2", time: 1, value: 1 });
  });
});

describe("projectFile: corrupt library entries", () => {
  /** `sourceWithAsset()` serialized, then its libraries replaced by `libraries` as raw JSON. */
  async function loadWithLibraries(
    libraries: Record<string, unknown>,
  ): Promise<SourceState | undefined> {
    const file = JSON.parse(await serializeProject(sourceWithAsset(), DEFAULT_VIEWPORT_VIEW)) as {
      source: object;
    };
    return loadedProject(JSON.stringify({ ...file, source: { ...file.source, ...libraries } }));
  }

  it("keeps a texture with its bytes and size, labelled by its name when unlabelled", async () => {
    const restored = await loadWithLibraries({
      assets: [
        { name: "spark", dataUrl: PIXEL_DATA_URL, width: 1, height: 1 },
        { name: "noSize", dataUrl: PIXEL_DATA_URL },
        { dataUrl: PIXEL_DATA_URL, width: 1, height: 1 },
        "junk",
      ],
    });
    expect(restored?.assets).toEqual([
      { name: "spark", label: "spark", dataUrl: PIXEL_DATA_URL, width: 1, height: 1 },
    ]);
  });

  it("keeps an environment with its bytes and byte size, and drops a payload that does not decode", async () => {
    const restored = await loadWithLibraries({
      environments: [
        { name: "sky", label: "sky.hdr", bytes: plainPayload(BYTES), byteSize: 3 },
        { name: "unsized", bytes: plainPayload(BYTES) },
        { name: "broken", bytes: { encoding: "gzip", data: "AAAA" }, byteSize: 3 },
        { name: "legacy", dataUrl: "data:,", byteSize: 3 },
        7,
      ],
    });
    expect(restored?.environments).toEqual([
      { name: "sky", label: "sky.hdr", bytes: BYTES, byteSize: 3 },
    ]);
  });

  it("keeps a scene, and makes a stale active scene or the removed void the studio", async () => {
    const scene = { name: "arena", label: "arena.glb", bytes: plainPayload(BYTES), byteSize: 3 };
    const kept = await loadWithLibraries({
      scenes: [scene, { ...scene, name: "studio" }],
      activeSceneName: "arena",
    });
    expect(kept?.scenes).toEqual([{ ...scene, bytes: BYTES }]);
    expect(kept?.activeSceneName).toBe("arena");
    const stale = await loadWithLibraries({ scenes: [], activeSceneName: "arena" });
    expect(stale?.activeSceneName).toBe("studio");
    expect((await loadWithLibraries({ activeSceneName: "void" }))?.activeSceneName).toBe("studio");
  });

  it("keeps a mesh asset with whole geometry, zeroing what is not a finite number", async () => {
    const floats = (values: readonly number[]) =>
      plainPayload(new Uint8Array(Float32Array.from(values).buffer));
    const restored = await loadWithLibraries({
      meshAssets: [
        {
          name: "rock",
          geometry: {
            position: floats([1, Number.NaN, 2]),
            normal: floats([0, 1, 0]),
            uv: floats([]),
            index: plainPayload(new Uint8Array(Uint32Array.from([0]).buffer)),
          },
        },
        {
          name: "torn",
          geometry: {
            position: plainPayload(new Uint8Array(3)),
            normal: floats([]),
            uv: floats([]),
            index: floats([]),
          },
        },
        { name: "noGeometry", byteSize: 4 },
      ],
    });
    expect(restored?.meshAssets).toEqual([
      {
        name: "rock",
        label: "rock",
        geometry: {
          position: Float32Array.from([1, 0, 2]),
          normal: Float32Array.from([0, 1, 0]),
          uv: new Float32Array(),
          index: Uint32Array.from([0]),
        },
        byteSize: 0,
      },
    ]);
  });

  it("reads a library that is not a list as empty", async () => {
    const restored = await loadWithLibraries({
      assets: {},
      environments: "x",
      scenes: 5,
      meshAssets: 3,
    });
    expect(restored?.assets).toEqual([]);
    expect(restored?.environments).toEqual([]);
    expect(restored?.scenes).toEqual([]);
    expect(restored?.meshAssets).toEqual([]);
  });
});

describe("projectFile: payloads", () => {
  it("gzips HDRI, scene and mesh payloads and reads them back as they were", async () => {
    const base = createInitialState().source;
    const repeated = new Uint8Array(4096).fill(7);
    const source: SourceState = {
      ...base,
      environments: [{ name: "sky", label: "sky.hdr", bytes: repeated, byteSize: 4096 }],
      scenes: [{ name: "arena", label: "arena.glb", bytes: repeated, byteSize: 4096 }],
      activeSceneName: "arena",
      meshAssets: [
        {
          name: "tri",
          label: "tri",
          geometry: {
            position: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
            normal: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
            uv: Float32Array.from([0, 0, 1, 0, 0, 1]),
            index: Uint32Array.from([0, 1, 2]),
          },
          byteSize: 108,
        },
      ],
    };
    const text = await serializeProject(source, DEFAULT_VIEWPORT_VIEW);
    const file = JSON.parse(text) as {
      source: { environments: { bytes: { encoding: string; data: string } }[] };
    };
    const stored = file.source.environments[0].bytes;
    expect(stored.encoding).toBe("gzip");
    expect(stored.data.length).toBeLessThan(200);
    expect(await loadedProject(text)).toEqual(source);
  });
});
