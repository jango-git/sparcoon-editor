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
  it("preserves the name and base64 assets", () => {
    const source = sourceWithAsset();
    const restored = deserializeProject(serializeProject(source));
    expect(restored?.name).toBe("my-effect");
    expect(restored?.assets).toEqual(source.assets);
    expect(restored?.assets[0]?.dataUrl).toBe(PIXEL_DATA_URL);
  });

  it("round-trips the whole document unchanged", () => {
    const source = sourceWithAsset();
    expect(deserializeProject(serializeProject(source))).toEqual(source);
  });

  it("rejects unreadable or non-project text", () => {
    expect(deserializeProject("not json {{")).toBeUndefined();
    expect(deserializeProject(JSON.stringify({ hello: "world" }))).toBeUndefined();
    expect(
      deserializeProject(JSON.stringify({ format: "sparcoon-project", version: 1 })),
    ).toBeUndefined();
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
