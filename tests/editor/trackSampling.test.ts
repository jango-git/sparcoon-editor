import { describe, expect, it } from "vitest";
import type { AnimationTrack, Keyframe } from "../../src/model/editorState";
import { sampleTrack } from "../../src/model/trackSampling";

/** A keyframe with an auto id, so tests read as `{ time, value }`. */
const key = (time: number, value: number | readonly number[]): Keyframe => ({
  id: `k${time}`,
  time,
  value,
});

const track = (keys: readonly Keyframe[]): AnimationTrack => ({ name: "x", keys });

describe("sampleTrack", () => {
  it("returns undefined for an empty track", () => {
    expect(sampleTrack(track([]), 1)).toBeUndefined();
  });

  it("holds a single key at every time", () => {
    const t = track([key(2, 5)]);
    expect(sampleTrack(t, 0)).toBe(5);
    expect(sampleTrack(t, 2)).toBe(5);
    expect(sampleTrack(t, 10)).toBe(5);
  });

  it("holds before the first and after the last key", () => {
    const t = track([key(1, 10), key(3, 30)]);
    expect(sampleTrack(t, 0)).toBe(10);
    expect(sampleTrack(t, 5)).toBe(30);
  });

  it("linearly interpolates scalars between keys", () => {
    const t = track([key(0, 0), key(2, 10)]);
    expect(sampleTrack(t, 1)).toBe(5);
    expect(sampleTrack(t, 0.5)).toBe(2.5);
  });

  it("interpolates vectors componentwise", () => {
    const t = track([key(0, [0, 10, 100]), key(1, [10, 20, 200])]);
    expect(sampleTrack(t, 0.5)).toEqual([5, 15, 150]);
  });

  it("picks the correct segment among many keys", () => {
    const t = track([key(0, 0), key(1, 100), key(2, 200)]);
    expect(sampleTrack(t, 1.5)).toBe(150);
  });
});
