import { describe, expect, it } from "vitest";
import type { Keyframe } from "../../src/model/editorState";
import {
  eulerToQuat,
  IDENTITY_TRANSFORM,
  normalizeQuat,
  quatToEuler,
  sampleTransform,
  slerpQuat,
  type Quat,
  type Transform,
  type TransformTrack,
} from "../../src/model/transform";

const key = (time: number, value: number | readonly number[]): Keyframe => ({
  id: `k${time}`,
  time,
  value,
});

const close = (a: readonly number[], b: readonly number[], epsilon = 1e-6): void => {
  expect(a.length).toBe(b.length);
  const digits = Math.round(-Math.log10(epsilon));
  a.forEach((component, i) => expect(component).toBeCloseTo(b[i], digits));
};

describe("euler <-> quaternion", () => {
  it("identity maps both ways", () => {
    close(eulerToQuat([0, 0, 0]), [0, 0, 0, 1]);
    close(quatToEuler([0, 0, 0, 1]), [0, 0, 0]);
  });

  it("90 degrees about Y is a clean quaternion", () => {
    close(eulerToQuat([0, 90, 0]), [0, Math.SQRT1_2, 0, Math.SQRT1_2]);
    close(quatToEuler([0, Math.SQRT1_2, 0, Math.SQRT1_2]), [0, 90, 0], 1e-4);
  });

  it("round-trips a mixed rotation", () => {
    const euler: readonly [number, number, number] = [30, -45, 60];
    close(quatToEuler(eulerToQuat(euler)), euler, 1e-4);
  });
});

describe("normalizeQuat", () => {
  it("rescales to unit length", () => {
    const n = normalizeQuat([0, 0, 0, 2]);
    close(n, [0, 0, 0, 1]);
  });

  it("falls back to identity for a zero quaternion", () => {
    expect(normalizeQuat([0, 0, 0, 0])).toEqual([0, 0, 0, 1]);
  });
});

describe("slerpQuat", () => {
  it("returns the endpoints at u = 0 and u = 1", () => {
    const a: Quat = [0, 0, 0, 1];
    const b = eulerToQuat([0, 90, 0]);
    close(slerpQuat(a, b, 0), a);
    close(slerpQuat(a, b, 1), b);
  });

  it("blends to the half-angle rotation at u = 0.5", () => {
    const a: Quat = [0, 0, 0, 1];
    const b = eulerToQuat([0, 90, 0]);
    close(slerpQuat(a, b, 0.5), eulerToQuat([0, 45, 0]), 1e-6);
  });
});

describe("sampleTransform", () => {
  const base: Transform = { position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [2, 2, 2] };

  it("returns the base transform when no channel is animated", () => {
    expect(sampleTransform(base, [], 5)).toEqual(base);
  });

  it("samples an animated channel and holds the rest at base", () => {
    const tracks: readonly TransformTrack[] = [
      { channel: "position", keys: [key(0, [0, 0, 0]), key(2, [10, 0, 0])] },
    ];
    const at1 = sampleTransform(base, tracks, 1);
    close(at1.position, [5, 0, 0]);
    // rotation + scale stay at base (unanimated).
    expect(at1.rotation).toEqual(base.rotation);
    expect(at1.scale).toEqual(base.scale);
  });

  it("slerps an animated rotation channel", () => {
    const tracks: readonly TransformTrack[] = [
      { channel: "rotation", keys: [key(0, [0, 0, 0, 1]), key(2, eulerToQuat([0, 90, 0]))] },
    ];
    close(sampleTransform(base, tracks, 1).rotation, eulerToQuat([0, 45, 0]), 1e-6);
  });

  it("leaves the identity transform untouched", () => {
    expect(sampleTransform(IDENTITY_TRANSFORM, [], 0)).toEqual(IDENTITY_TRANSFORM);
  });
});
