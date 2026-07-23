import { describe, expect, it } from "vitest";
import { frameCount, frameOf, snapTimeToFrame, timeOfFrame } from "../../src/model/frames";

describe("frame helpers", () => {
  it("converts time to the nearest frame and back", () => {
    expect(frameOf(0.5, 30)).toBe(15);
    expect(frameOf(0.51, 30)).toBe(15);
    expect(timeOfFrame(15, 30)).toBeCloseTo(0.5);
  });

  it("snaps a time onto the frame grid", () => {
    expect(snapTimeToFrame(0.51, 30)).toBeCloseTo(0.5);
    expect(snapTimeToFrame(0.49, 30)).toBeCloseTo(0.5);
    expect(snapTimeToFrame(0.02, 30)).toBeCloseTo(1 / 30);
  });

  it("counts whole frames over a duration (at least one)", () => {
    expect(frameCount(5, 30)).toBe(150);
    expect(frameCount(0, 30)).toBe(1);
  });

  it("degrades to no grid when fps is non-positive", () => {
    expect(snapTimeToFrame(1.234, 0)).toBe(1.234);
    expect(frameOf(1.234, 0)).toBe(0);
    expect(frameCount(5, 0)).toBe(1);
  });
});
