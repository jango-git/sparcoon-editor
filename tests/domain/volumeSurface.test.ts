import { SphereGeometry } from "three";
import { describe, expect, it } from "vitest";

import { bakeVolume } from "../../src/domain/volumeBake";
import { volumeSurface } from "../../src/domain/volumeSurface";
import { bakeGeometryArrays } from "../../src/render/meshGeometryBaking";

const SETTINGS = {
  boxMin: [-1, -1, -1],
  boxMax: [1, 1, 1],
  resolution: 24,
  band: 0.5,
  mode: "solid",
  thickness: 0,
} as const;

describe("volumeSurface", () => {
  it("lays the surface where the distance is the level, its normals facing out", async () => {
    const baked = await bakeVolume(bakeGeometryArrays(new SphereGeometry(0.5, 48, 24)), SETTINGS);
    for (const level of [0, 0.2]) {
      const { positions, normals, indices } = volumeSurface(baked, level);
      expect(indices.length).toBeGreaterThan(0);
      expect(indices.length % 3).toBe(0);
      expect(Math.max(...indices)).toBeLessThan(positions.length / 3);
      for (let v = 0; v < positions.length; v += 3) {
        const p = [positions[v], positions[v + 1], positions[v + 2]];
        const n = [normals[v], normals[v + 1], normals[v + 2]];
        const radius = Math.hypot(...p);
        expect(Math.abs(radius - (0.5 + level))).toBeLessThan(0.04);
        // Outward: along the position from the centre.
        expect((p[0] * n[0] + p[1] * n[1] + p[2] * n[2]) / radius).toBeGreaterThan(0.9);
      }
    }
  });

  it("winds each triangle to face out", async () => {
    const baked = await bakeVolume(bakeGeometryArrays(new SphereGeometry(0.5, 48, 24)), SETTINGS);
    const { positions, indices } = volumeSurface(baked, 0);
    const at = (i: number): number[] => [0, 1, 2].map((axis) => positions[indices[i] * 3 + axis]);
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [at(i), at(i + 1), at(i + 2)] as [number[], number[], number[]];
      const ab = b.map((value, axis) => value - a[axis]);
      const ac = c.map((value, axis) => value - a[axis]);
      const normal = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
      ];
      const centre = [0, 1, 2].map((axis) => (a[axis] + b[axis] + c[axis]) / 3);
      expect(
        normal.reduce((dot, value, axis) => dot + value * centre[axis], 0),
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it("is empty where the volume holds no surface", async () => {
    const baked = await bakeVolume(bakeGeometryArrays(new SphereGeometry(0.5, 48, 24)), SETTINGS);
    expect(volumeSurface(baked, 2).indices).toHaveLength(0);
  });
});
