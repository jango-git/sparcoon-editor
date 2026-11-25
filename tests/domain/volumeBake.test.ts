import { BoxGeometry, PlaneGeometry, SphereGeometry } from "three";
import { describe, expect, it } from "vitest";

import {
  bakeGridSize,
  bakeSettingsProblem,
  bakeVolume,
  defaultBakeSettings,
  fitBox,
  isClosedMesh,
  type VolumeBakeResult,
  type VolumeBakeSettings,
} from "../../src/domain/volumeBake";
import type { BakedMeshGeometry } from "../../src/model/editorState";
import { bakeGeometryArrays } from "../../src/render/meshGeometryBaking";

const sphere = (): BakedMeshGeometry => bakeGeometryArrays(new SphereGeometry(0.5, 48, 24));
const box = (): BakedMeshGeometry => bakeGeometryArrays(new BoxGeometry(1, 1, 1));

const SETTINGS: VolumeBakeSettings = {
  boxMin: [-1, -1, -1],
  boxMax: [1, 1, 1],
  resolution: 24,
  band: 0.5,
  mode: "solid",
  thickness: 0,
};

/** Each texel's centre and the distance its byte holds. */
function* texels(result: VolumeBakeResult): Generator<{ p: number[]; d: number }> {
  const [nx, ny, nz] = result.size;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const p = [i, j, k].map(
          (index, axis) =>
            result.boxMin[axis] +
            ((index + 0.5) / result.size[axis]) * (result.boxMax[axis] - result.boxMin[axis]),
        );
        const byte = result.texels[i + nx * (j + ny * k)];
        yield { p, d: (byte / 255) * result.scale + result.bias };
      }
    }
  }
}

describe("bakeVolume", () => {
  it("bakes a sphere's signed distance, clamped to the band", async () => {
    const result = await bakeVolume(sphere(), SETTINGS);
    expect(result.size).toEqual([24, 24, 24]);
    expect([result.scale, result.bias]).toEqual([1, -0.5]);
    let worst = 0;
    for (const { p, d } of texels(result)) {
      const exact = Math.min(Math.max(Math.hypot(...p) - 0.5, -0.5), 0.5);
      worst = Math.max(worst, Math.abs(d - exact));
    }
    // Faceting and the byte's step (1/255) apart.
    expect(worst).toBeLessThan(0.012);
  });

  it("finds a box's inside on every axis, and keeps it through a hole", async () => {
    const closed = await bakeVolume(box(), { ...SETTINGS, band: 1 });
    for (const { p, d } of texels(closed)) {
      const inside = p.every((component) => Math.abs(component) < 0.5);
      expect(d < 0, p.join(",")).toBe(inside);
    }
    const mesh = box();
    // Two triangles of the +X face gone - rows along X through it see one crossing less.
    const holed = { ...mesh, index: mesh.index.slice(6) };
    expect(isClosedMesh(holed)).toBe(false);
    const baked = await bakeVolume(holed, { ...SETTINGS, band: 1 });
    for (const { p, d } of texels(baked)) {
      if (p.every((component) => Math.abs(component) < 0.4)) {
        expect(d).toBeLessThan(0);
      }
    }
  });

  it("bakes an open mesh as a shell of its thickness", async () => {
    const plane = bakeGeometryArrays(new PlaneGeometry(2, 2));
    const settings = defaultBakeSettings(plane, isClosedMesh(plane));
    expect(settings.mode).toBe("shell");
    const result = await bakeVolume(plane, { ...SETTINGS, mode: "shell", thickness: 0.1 });
    for (const { p, d } of texels(result)) {
      expect(d).toBeCloseTo(Math.min(Math.abs(p[2]) - 0.1, 0.5), 2);
    }
  });

  it("stops when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(bakeVolume(box(), SETTINGS, { signal: controller.signal })).rejects.toThrow();
  });

  it("refuses a mesh without triangles and settings with a problem", async () => {
    await expect(bakeVolume({ ...box(), index: new Uint32Array() }, SETTINGS)).rejects.toThrow(
      /no triangles/,
    );
    await expect(bakeVolume(box(), { ...SETTINGS, band: 0 })).rejects.toThrow(/band/);
  });
});

describe("bake settings", () => {
  it("defaults to the mesh's bounds padded by a tenth of its longest side, solid when closed", () => {
    const settings = defaultBakeSettings(box(), isClosedMesh(box()));
    expect(settings.mode).toBe("solid");
    expect(settings.band).toBeCloseTo(0.1, 6);
    expect(settings.boxMin.map((value) => Math.round(value * 1e6) / 1e6)).toEqual([
      -0.6, -0.6, -0.6,
    ]);
    expect(isClosedMesh(sphere())).toBe(true);
  });

  it("puts the resolution on the longest side, the others in proportion", () => {
    expect(bakeGridSize({ ...SETTINGS, boxMax: [1, 0, 3], resolution: 40 })).toEqual([20, 10, 40]);
  });
});

describe("bake settings checks", () => {
  it("finds what is wrong with settings, and nothing with sound ones", () => {
    expect(bakeSettingsProblem(SETTINGS)).toBeUndefined();
    for (const wrong of [
      { boxMin: [1, -1, -1] as const },
      { boxMax: [1, Number.NaN, 1] as const },
      { resolution: 2 },
      { resolution: 129 },
      { resolution: 8.5 },
      { band: 0 },
      { thickness: -1 },
      { mode: "hollow" as never },
    ]) {
      expect(bakeSettingsProblem({ ...SETTINGS, ...wrong }), JSON.stringify(wrong)).toBeDefined();
    }
  });

  it("fits the box to the mesh, padded on every side", () => {
    expect(fitBox(box(), 0.25)).toEqual({
      boxMin: [-0.75, -0.75, -0.75],
      boxMax: [0.75, 0.75, 0.75],
    });
  });
});
