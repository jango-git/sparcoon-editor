import { describe, expect, it } from "vitest";

import { createInitialState, type SourceState } from "../../src/model/editorState";
import { deserializeProject, serializeProject } from "../../src/persistence/projectFile";

/** A tiny opaque data URL - stands in for a base64 asset that must survive the round-trip. */
const PIXEL_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function sourceWithAsset(): SourceState {
  const base = createInitialState().source;
  return {
    ...base,
    name: "my-effect",
    assets: [{ name: "spark", label: "spark.png", dataUrl: PIXEL_DATA_URL, width: 1, height: 1 }],
  };
}

describe("projectFile: serialize/deserialize round-trip", () => {
  it("round-trips the whole document unchanged, its base64 assets included", () => {
    const source = sourceWithAsset();
    const restored = deserializeProject(serializeProject(source));
    expect(restored).toEqual(source);
    expect(restored?.assets[0]?.dataUrl).toBe(PIXEL_DATA_URL);
  });

  it("loads a project saved before the loop setting existed as looping, and keeps an explicit off", () => {
    const source = createInitialState().source;
    const legacy = JSON.parse(serializeProject(source)) as {
      source: { timeline: Record<string, unknown> };
    };
    delete legacy.source.timeline["loop"];
    expect(deserializeProject(JSON.stringify(legacy))?.timeline.loop).toBe(true);

    const once = { ...source, timeline: { ...source.timeline, loop: false } };
    expect(deserializeProject(serializeProject(once))?.timeline.loop).toBe(false);
  });

  it("keeps an emitter's editor-only events flag, and leaves it off when absent", () => {
    const base = createInitialState().source;
    const [emitter, ...rest] = base.scene.emitters;
    const live: SourceState = {
      ...base,
      scene: { ...base.scene, emitters: [{ ...emitter, liveEvents: true }, ...rest] },
    };
    expect(deserializeProject(serializeProject(live))?.scene.emitters[0]?.liveEvents).toBe(true);
    const restored = deserializeProject(serializeProject(base))?.scene.emitters[0];
    expect(restored !== undefined && "liveEvents" in restored).toBe(false);
  });

  it("rejects unreadable or non-project text", () => {
    expect(deserializeProject("not json {{")).toBeUndefined();
    expect(deserializeProject(JSON.stringify({ hello: "world" }))).toBeUndefined();
    expect(
      deserializeProject(JSON.stringify({ format: "sparcoon-project", version: 1 })),
    ).toBeUndefined();
  });

  it("preserves saved palette swatches", () => {
    const base = createInitialState().source;
    const source: SourceState = {
      ...base,
      palette: [{ name: "swatch_1", label: "Accent", color: [1, 0.4, 0, 1] }],
    };
    const restored = deserializeProject(serializeProject(source));
    expect(restored?.palette).toEqual(source.palette);
  });

  it("tolerates a bare source with no envelope", () => {
    const source = sourceWithAsset();
    expect(deserializeProject(JSON.stringify(source))?.name).toBe("my-effect");
  });

  it("seeds the id counter from the raw document before backfilling a missing keyframe id", () => {
    // A legacy/malformed keyframe with no `id` sits alongside one already named "key_1" - the
    // lowest id a fresh session's counter would mint. If normalization backfills the missing id
    // before the counter has seen "key_1" (seeding only after normalizeSource returns), the
    // backfill collides with it - two distinct keyframes on the same track sharing one id.
    const raw = {
      scene: {
        emitters: [
          {
            id: "emitter_1",
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

    const restored = deserializeProject(JSON.stringify(raw));
    const keys = restored?.scene.emitters[0]?.tracks[0]?.keys;
    expect(keys).toHaveLength(2);
    const ids = keys?.map((key) => key.id) ?? [];
    expect(ids).toContain("key_1");
    expect(new Set(ids).size).toBe(2); // the backfilled id didn't collide with "key_1"
  });
});

describe("projectFile: renamed node inputs", () => {
  it("loads a spawn-cylinder saved with `length` under its current `height`, value and wire alike", () => {
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

    const loaded = deserializeProject(serializeProject(saved))?.scene.emitters[0].behaviorGraph;

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
  it("loads an animated-texture's old uvPrevious / uvCurrent wires as uvFrame / uvNext", () => {
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
    const loaded = deserializeProject(serializeProject(saved))?.scene.emitters[0].renderGraph;

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
  it("keeps a key's curve, and drops one it does not know (the key then reads linear)", () => {
    const base = createInitialState().source;
    const [emitter] = base.scene.emitters;
    const source: SourceState = {
      ...base,
      scene: {
        ...base.scene,
        emitters: [
          {
            ...emitter,
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
    const keys = deserializeProject(serializeProject(source))?.scene.emitters[0].tracks[0]?.keys;
    expect(keys?.[0]).toEqual({ id: "k1", time: 0, value: 0, ease: "inOut" });
    expect(keys?.[1]).toEqual({ id: "k2", time: 1, value: 1 });
  });
});

describe("projectFile: corrupt library entries", () => {
  /** `sourceWithAsset()` serialized, then its libraries replaced by `libraries` as raw JSON. */
  function loadWithLibraries(libraries: Record<string, unknown>): SourceState | undefined {
    const file = JSON.parse(serializeProject(sourceWithAsset())) as { source: object };
    return deserializeProject(
      JSON.stringify({ ...file, source: { ...file.source, ...libraries } }),
    );
  }

  it("keeps a texture with its bytes and size, labelled by its name when unlabelled", () => {
    const restored = loadWithLibraries({
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

  it("keeps an environment with its bytes and byte size", () => {
    const restored = loadWithLibraries({
      environments: [
        { name: "studio", label: "studio.hdr", dataUrl: "data:,", byteSize: 3 },
        { name: "unsized", dataUrl: "data:," },
        7,
      ],
    });
    expect(restored?.environments).toEqual([
      { name: "studio", label: "studio.hdr", dataUrl: "data:,", byteSize: 3 },
    ]);
  });

  it("keeps a mesh asset with baked geometry, zeroing what is not a finite number", () => {
    const restored = loadWithLibraries({
      meshAssets: [
        {
          name: "rock",
          geometry: { position: [1, "x", true, 2], normal: [0, 1, 0], uv: "junk", index: [0] },
        },
        { name: "noGeometry", byteSize: 4 },
        { geometry: { position: [] } },
      ],
    });
    expect(restored?.meshAssets).toEqual([
      {
        name: "rock",
        label: "rock",
        geometry: { position: [1, 0, 0, 2], normal: [0, 1, 0], uv: [], index: [0] },
        byteSize: 0,
      },
    ]);
  });

  it("reads a library that is not a list as empty", () => {
    const restored = loadWithLibraries({ assets: {}, environments: "x", meshAssets: 3 });
    expect(restored?.assets).toEqual([]);
    expect(restored?.environments).toEqual([]);
    expect(restored?.meshAssets).toEqual([]);
  });
});
