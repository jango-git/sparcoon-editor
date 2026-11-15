/**
 * Bakes a mesh into a signed distance field - an R8 volume over a box, each texel the distance from
 * its centre to the mesh's surface, negative inside, clamped to a band around the surface. The
 * byte `b` of a texel holds the distance `b / 255 * scale + bias`.
 *
 * Distances are exact within a texel of each triangle, then carried across the grid by sweeps that
 * hand each texel its neighbours' closest triangles. Inside is decided by counting a mesh's surface
 * crossings along the texel's row on each axis - odd is inside - and taking the majority of the
 * three, so a small hole spoils one axis at most. An open mesh, which has no inside, bakes as a
 * shell - the distance less a thickness.
 */

import type { BakedMeshGeometry } from "../model/editorState";
import type { VolumeSize, VolumeTexels } from "./volumeAtlas";

type Vec3 = readonly [number, number, number];

/** A solid has an inside. A shell is a band of `thickness` around the surface. */
export type VolumeBakeMode = "solid" | "shell";

export interface VolumeBakeSettings {
  /** The box the volume fills, in the mesh's space. */
  readonly boxMin: Vec3;
  readonly boxMax: Vec3;
  /** Texels along the box's longest side. */
  readonly resolution: number;
  /** The distance on either side of the surface the bytes span. Farther is clamped. */
  readonly band: number;
  readonly mode: VolumeBakeMode;
  /** Shell only - half the shell's width. */
  readonly thickness: number;
}

export interface VolumeBakeResult extends VolumeTexels {
  readonly boxMin: Vec3;
  readonly boxMax: Vec3;
  readonly scale: number;
  readonly bias: number;
}

export interface VolumeBakeProgress {
  /** Aborts the bake, which then rejects with the signal's reason. */
  readonly signal?: AbortSignal;
  /** Called now and then with the share of the bake done, `0..1`. */
  readonly onProgress?: (done: number) => void;
}

/** The fewest and most texels a volume may have along its longest side. */
export const VOLUME_RESOLUTION_RANGE = { min: 4, max: 128 } as const;

/** The mesh's bounding box. */
export function meshBounds(mesh: BakedMeshGeometry): { readonly min: Vec3; readonly max: Vec3 } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.position.length; i++) {
    const axis = i % 3;
    const value = mesh.position[i] as number;
    min[axis] = Math.min(min[axis] as number, value);
    max[axis] = Math.max(max[axis] as number, value);
  }
  return { min: min as unknown as Vec3, max: max as unknown as Vec3 };
}

/** Whether every edge of the mesh is shared by an even number of triangles, vertices welded by
 *  position (a millionth of its size apart at most, as a seam's twin vertices are) - a mesh with an
 *  inside. */
export function isClosedMesh(mesh: BakedMeshGeometry): boolean {
  const { min, max } = meshBounds(mesh);
  const tolerance = 1e-6 * Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-9);
  const welded = new Map<string, number>();
  const vertexId = (vertex: number): number => {
    const key = [0, 1, 2]
      .map((axis) => String(Math.round((mesh.position[vertex * 3 + axis] as number) / tolerance)))
      .join(",");
    let id = welded.get(key);
    if (id === undefined) {
      id = welded.size;
      welded.set(key, id);
    }
    return id;
  };
  const edges = new Map<string, number>();
  for (let t = 0; t + 2 < mesh.index.length; t += 3) {
    const corners = [0, 1, 2].map((corner) => vertexId(mesh.index[t + corner] as number));
    for (let corner = 0; corner < 3; corner++) {
      const a = corners[corner] as number;
      const b = corners[(corner + 1) % 3] as number;
      const key = a < b ? `${String(a)}:${String(b)}` : `${String(b)}:${String(a)}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  return edges.size > 0 && [...edges.values()].every((count) => count % 2 === 0);
}

/** The mesh's bounds padded by `padding` on every side: a box the whole mesh fits in. */
export function fitBox(
  mesh: BakedMeshGeometry,
  padding: number,
): { readonly boxMin: Vec3; readonly boxMax: Vec3 } {
  const { min, max } = meshBounds(mesh);
  return {
    boxMin: [min[0] - padding, min[1] - padding, min[2] - padding],
    boxMax: [max[0] + padding, max[1] + padding, max[2] + padding],
  };
}

/** Settings for baking `mesh`, `closed` as {@link isClosedMesh} finds it - its bounds padded by the
 *  band, 64 texels across, a band of a tenth of its longest side, solid when it is closed. */
export function defaultBakeSettings(mesh: BakedMeshGeometry, closed: boolean): VolumeBakeSettings {
  const { min, max } = meshBounds(mesh);
  const longest = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const band = longest > 0 ? longest / 10 : 0.1;
  return {
    ...fitBox(mesh, band),
    resolution: 64,
    band,
    mode: closed ? "solid" : "shell",
    thickness: band / 4,
  };
}

/** What is wrong with `settings`, if anything: a box that is not finite with min below max, a
 *  resolution out of {@link VOLUME_RESOLUTION_RANGE}, a band that is not positive, a negative
 *  thickness, an unknown mode. */
export function bakeSettingsProblem(settings: VolumeBakeSettings): string | undefined {
  const { boxMin, boxMax, resolution, band, thickness } = settings;
  const mode: unknown = settings.mode;
  const vector = (value: unknown): boolean =>
    Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
  if (
    !vector(boxMin) ||
    !vector(boxMax) ||
    boxMin.some((value, axis) => value >= (boxMax[axis] as number))
  ) {
    return "boxMin and boxMax must be [x, y, z], min below max";
  }
  const { min, max } = VOLUME_RESOLUTION_RANGE;
  if (!Number.isInteger(resolution) || resolution < min || resolution > max) {
    return `resolution must be an integer from ${String(min)} to ${String(max)}`;
  }
  if (!(Number.isFinite(band) && band > 0)) {
    return "band must be positive";
  }
  if (!(Number.isFinite(thickness) && thickness >= 0)) {
    return "thickness must not be negative";
  }
  if (mode !== "solid" && mode !== "shell") {
    return 'mode must be "solid" or "shell"';
  }
  return undefined;
}

/** The texel grid the settings bake - `resolution` along the longest side, the others in proportion
 *  (at least one texel). */
export function bakeGridSize(settings: VolumeBakeSettings): VolumeSize {
  const extent = [0, 1, 2].map((axis) =>
    Math.max(0, (settings.boxMax[axis] as number) - (settings.boxMin[axis] as number)),
  );
  const longest = Math.max(...extent);
  const count = (axis: number): number =>
    longest > 0
      ? Math.max(1, Math.round(((extent[axis] as number) / longest) * settings.resolution))
      : 1;
  return [count(0), count(1), count(2)];
}

/** The texels a bake fills: how many on each axis, where the first one's corner is, how big one
 *  is. Texel `i` on an axis is centred at `origin + (i + 0.5) * cell`. */
interface BakeGrid {
  readonly size: VolumeSize;
  readonly origin: Vec3;
  readonly cell: Vec3;
}

function bakeGrid(settings: VolumeBakeSettings): BakeGrid {
  const size = bakeGridSize(settings);
  const cell = [0, 1, 2].map(
    (axis) =>
      Math.max((settings.boxMax[axis] as number) - (settings.boxMin[axis] as number), 1e-9) /
      (size[axis] as number),
  ) as unknown as Vec3;
  return { size, origin: settings.boxMin, cell };
}

/** The centre of texel `index` on `axis`. */
function texelCentre(grid: BakeGrid, index: number, axis: number): number {
  return (grid.origin[axis] as number) + (index + 0.5) * (grid.cell[axis] as number);
}

/** The mesh's triangles as 9 floats each: their corners' coordinates. */
function triangleCorners(mesh: BakedMeshGeometry): Float64Array {
  const triangles = Math.floor(mesh.index.length / 3);
  const corners = new Float64Array(triangles * 9);
  for (let t = 0; t < triangles; t++) {
    for (let corner = 0; corner < 3; corner++) {
      const vertex = mesh.index[t * 3 + corner] as number;
      for (let axis = 0; axis < 3; axis++) {
        corners[t * 9 + corner * 3 + axis] = mesh.position[vertex * 3 + axis] as number;
      }
    }
  }
  return corners;
}

/** Squared distance from `(px, py, pz)` to triangle `t` of `corners` (9 floats a triangle). */
function triangleDistanceSquared(
  corners: Float64Array,
  t: number,
  px: number,
  py: number,
  pz: number,
): number {
  const o = t * 9;
  const ax = corners[o] as number;
  const ay = corners[o + 1] as number;
  const az = corners[o + 2] as number;
  const abx = (corners[o + 3] as number) - ax;
  const aby = (corners[o + 4] as number) - ay;
  const abz = (corners[o + 5] as number) - az;
  const acx = (corners[o + 6] as number) - ax;
  const acy = (corners[o + 7] as number) - ay;
  const acz = (corners[o + 8] as number) - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  // The closest point by the Voronoi region of the triangle `p` lies in (Ericson, 5.1.5).
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let u: number;
  let v: number;
  if (d1 <= 0 && d2 <= 0) {
    u = 0;
    v = 0;
  } else {
    const bpx = apx - abx;
    const bpy = apy - aby;
    const bpz = apz - abz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    const cpx = apx - acx;
    const cpy = apy - acy;
    const cpz = apz - acz;
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;
    const vc = d1 * d4 - d3 * d2;
    const vb = d5 * d2 - d1 * d6;
    const va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) {
      u = 1;
      v = 0;
    } else if (d6 >= 0 && d5 <= d6) {
      u = 0;
      v = 1;
    } else if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      u = d1 / (d1 - d3);
      v = 0;
    } else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      u = 0;
      v = d2 / (d2 - d6);
    } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
      u = 1 - w;
      v = w;
    } else {
      const denominator = 1 / (va + vb + vc);
      u = vb * denominator;
      v = vc * denominator;
    }
  }
  const dx = apx - abx * u - acx * v;
  const dy = apy - aby * u - acy * v;
  const dz = apz - abz * u - acz * v;
  return dx * dx + dy * dy + dz * dz;
}

/** Yields to the page every few milliseconds, reporting progress and honouring the abort. */
class BakeClock {
  private last = performance.now();

  constructor(private readonly progress: VolumeBakeProgress) {}

  public async tick(done: number): Promise<void> {
    if (performance.now() - this.last < 12) {
      return;
    }
    this.progress.onProgress?.(done);
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.progress.signal?.throwIfAborted();
    this.last = performance.now();
  }
}

/** Whether the 2D point `(u, v)` is in the triangle `(ax, ay) (bx, by) (cx, cy)` (counter-clockwise),
 *  a point on an edge counting for the triangle on one side of it only (the top-left rule). */
function edgeOwns(ax: number, ay: number, bx: number, by: number, u: number, v: number): boolean {
  const w = (bx - ax) * (v - ay) - (by - ay) * (u - ax);
  if (w !== 0) {
    return w > 0;
  }
  return by < ay || (by === ay && bx < ax);
}

/**
 * How many of the three axes find each texel centre inside the mesh - along every row of texels on
 * an axis, the crossings of the surface before the centre, odd being inside.
 */
async function insideVotes(
  corners: Float64Array,
  grid: BakeGrid,
  clock: BakeClock,
  progress: (axis: number, done: number) => number,
): Promise<Uint8Array> {
  const { size, origin, cell } = grid;
  const triangles = corners.length / 9;
  const [nx, ny, nz] = size;
  const votes = new Uint8Array(nx * ny * nz);
  const strides = [1, nx, nx * ny];
  for (let axis = 0; axis < 3; axis++) {
    const b = (axis + 1) % 3;
    const c = (axis + 2) % 3;
    const nb = size[b] as number;
    const nc = size[c] as number;
    const na = size[axis] as number;
    const rows: number[][] = Array.from({ length: nb * nc }, () => []);
    // A corner in index space - texel centres at the integers.
    const at = (t: number, corner: number, dimension: number): number =>
      ((corners[t * 9 + corner * 3 + dimension] as number) - (origin[dimension] as number)) /
        (cell[dimension] as number) -
      0.5;
    for (let t = 0; t < triangles; t++) {
      let [au, av, aw] = [at(t, 0, b), at(t, 0, c), at(t, 0, axis)];
      let [bu, bv, bw] = [at(t, 1, b), at(t, 1, c), at(t, 1, axis)];
      const [cu, cv, cw] = [at(t, 2, b), at(t, 2, c), at(t, 2, axis)];
      const area = (bu - au) * (cv - av) - (bv - av) * (cu - au);
      if (area === 0) {
        continue;
      }
      if (area < 0) {
        [au, av, aw, bu, bv, bw] = [bu, bv, bw, au, av, aw];
      }
      const signedArea = Math.abs(area);
      const u0 = Math.max(0, Math.ceil(Math.min(au, bu, cu)));
      const u1 = Math.min(nb - 1, Math.floor(Math.max(au, bu, cu)));
      const v0 = Math.max(0, Math.ceil(Math.min(av, bv, cv)));
      const v1 = Math.min(nc - 1, Math.floor(Math.max(av, bv, cv)));
      for (let v = v0; v <= v1; v++) {
        for (let u = u0; u <= u1; u++) {
          if (
            edgeOwns(au, av, bu, bv, u, v) &&
            edgeOwns(bu, bv, cu, cv, u, v) &&
            edgeOwns(cu, cv, au, av, u, v)
          ) {
            // The crossing along the axis, from the barycentric weights of the row.
            const wa = ((bu - u) * (cv - v) - (bv - v) * (cu - u)) / signedArea;
            const wb = ((cu - u) * (av - v) - (cv - v) * (au - u)) / signedArea;
            (rows[v * nb + u] as number[]).push(wa * aw + wb * bw + (1 - wa - wb) * cw);
          }
        }
      }
      await clock.tick(progress(axis, t / triangles));
    }
    for (let row = 0; row < rows.length; row++) {
      const crossings = (rows[row] as number[]).sort((first, second) => first - second);
      const u = row % nb;
      const v = Math.floor(row / nb);
      const base = u * (strides[b] as number) + v * (strides[c] as number);
      let passed = 0;
      for (let i = 0; i < na; i++) {
        while (passed < crossings.length && (crossings[passed] as number) < i) {
          passed++;
        }
        if (passed % 2 === 1) {
          const index = base + i * (strides[axis] as number);
          votes[index] = (votes[index] as number) + 1;
        }
      }
    }
  }
  return votes;
}

/**
 * The unsigned distance from each texel centre to the nearest triangle: exact within a texel of
 * each triangle, then carried across the grid by sweeps that offer each texel the closest
 * triangles of its neighbours behind it, all 8 ways, twice.
 */
async function unsignedDistances(
  corners: Float64Array,
  grid: BakeGrid,
  clock: BakeClock,
): Promise<Float64Array> {
  const triangles = corners.length / 9;
  const [nx, ny, nz] = grid.size;
  const distance = new Float64Array(nx * ny * nz).fill(Infinity);
  const closest = new Int32Array(nx * ny * nz).fill(-1);
  const offer = (i: number, j: number, k: number, t: number): void => {
    const index = i + nx * (j + ny * k);
    const d = triangleDistanceSquared(
      corners,
      t,
      texelCentre(grid, i, 0),
      texelCentre(grid, j, 1),
      texelCentre(grid, k, 2),
    );
    if (d < (distance[index] as number)) {
      distance[index] = d;
      closest[index] = t;
    }
  };
  // A coordinate in texel index space: texel centres at the integers.
  const toIndex = (value: number, axis: number): number =>
    (value - (grid.origin[axis] as number)) / (grid.cell[axis] as number) - 0.5;
  for (let t = 0; t < triangles; t++) {
    const [[i0, i1], [j0, j1], [k0, k1]] = [0, 1, 2].map((axis) => {
      const values = [0, 1, 2].map((corner) => corners[t * 9 + corner * 3 + axis] as number);
      const n = grid.size[axis] as number;
      return [
        Math.max(0, Math.floor(toIndex(Math.min(...values), axis)) - 1),
        Math.min(n - 1, Math.ceil(toIndex(Math.max(...values), axis)) + 1),
      ];
    }) as [[number, number], [number, number], [number, number]];
    for (let k = k0; k <= k1; k++) {
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          offer(i, j, k, t);
        }
      }
    }
    await clock.tick((0.2 * t) / triangles);
  }
  const directions = [-1, 1];
  let sweep = 0;
  for (let round = 0; round < 2; round++) {
    for (const dk of directions) {
      for (const dj of directions) {
        for (const di of directions) {
          const neighbours = [
            [-di, 0, 0],
            [0, -dj, 0],
            [0, 0, -dk],
            [-di, -dj, 0],
            [-di, 0, -dk],
            [0, -dj, -dk],
            [-di, -dj, -dk],
          ] as const;
          for (let kk = 0; kk < nz; kk++) {
            const k = dk > 0 ? kk : nz - 1 - kk;
            for (let jj = 0; jj < ny; jj++) {
              const j = dj > 0 ? jj : ny - 1 - jj;
              for (let ii = 0; ii < nx; ii++) {
                const i = di > 0 ? ii : nx - 1 - ii;
                const own = closest[i + nx * (j + ny * k)];
                for (const [oi, oj, ok] of neighbours) {
                  const ni = i + oi;
                  const nj = j + oj;
                  const nk = k + ok;
                  if (ni < 0 || nj < 0 || nk < 0 || ni >= nx || nj >= ny || nk >= nz) {
                    continue;
                  }
                  const t = closest[ni + nx * (nj + ny * nk)] as number;
                  if (t >= 0 && t !== own) {
                    offer(i, j, k, t);
                  }
                }
              }
            }
            await clock.tick(0.2 + (0.5 * (sweep + kk / nz)) / 16);
          }
          sweep++;
        }
      }
    }
  }
  return distance.map(Math.sqrt);
}

/** The texels of the distances: signed by the inside `votes` (a solid) or less the thickness (a
 *  shell), clamped to the band, `-band..band` spread over the bytes. */
function encodeTexels(
  distances: Float64Array,
  votes: Uint8Array | undefined,
  settings: VolumeBakeSettings,
): Uint8Array<ArrayBuffer> {
  const { band } = settings;
  const texels = new Uint8Array(distances.length);
  for (let index = 0; index < distances.length; index++) {
    const unsigned = distances[index] as number;
    const signed =
      votes === undefined
        ? unsigned - settings.thickness
        : (votes[index] as number) >= 2
          ? -unsigned
          : unsigned;
    texels[index] = Math.round(Math.min(Math.max((signed + band) / (2 * band), 0), 1) * 255);
  }
  return texels;
}

/**
 * Bakes `mesh` into a volume by `settings`.
 * @throws When the mesh has no triangles or the settings have a problem
 * ({@link bakeSettingsProblem}). Rejects with the signal's reason when aborted.
 */
export async function bakeVolume(
  mesh: BakedMeshGeometry,
  settings: VolumeBakeSettings,
  progress: VolumeBakeProgress = {},
): Promise<VolumeBakeResult> {
  const problem = bakeSettingsProblem(settings);
  if (problem !== undefined) {
    throw new Error(`bakeVolume: ${problem}`);
  }
  const corners = triangleCorners(mesh);
  if (corners.length === 0) {
    throw new Error("bakeVolume: the mesh has no triangles");
  }
  progress.signal?.throwIfAborted();
  const clock = new BakeClock(progress);
  const grid = bakeGrid(settings);
  const distances = await unsignedDistances(corners, grid, clock);
  const votes =
    settings.mode === "solid"
      ? await insideVotes(corners, grid, clock, (axis, done) => 0.7 + (0.3 * (axis + done)) / 3)
      : undefined;
  progress.onProgress?.(1);
  const { boxMin, boxMax, band } = settings;
  return {
    size: grid.size,
    texels: encodeTexels(distances, votes, settings),
    boxMin,
    boxMax,
    scale: 2 * band,
    bias: -band,
  };
}
