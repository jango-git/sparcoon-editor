/**
 * The surface a baked volume holds at a distance, as a triangle mesh (naive surface nets): a vertex
 * in each cell of 8 texel centres the surface passes through, at the mean of its crossings of the
 * cell's edges, and a quad across each texel edge the surface crosses, joining the 4 cells around
 * it. Each vertex's normal is the volume's gradient over its cell. Drawn from the bytes as baked,
 * it shows what the bake holds: its resolution, its band, its holes.
 */

import type { VolumeBakeResult } from "./volumeBake";

export interface VolumeSurface {
  readonly positions: Float32Array<ArrayBuffer>;
  readonly normals: Float32Array<ArrayBuffer>;
  readonly indices: Uint32Array<ArrayBuffer>;
}

/** The corners of a cell, as offsets on x, y and z. */
const CORNERS = [0, 1, 2, 3, 4, 5, 6, 7].map((c) => [c & 1, (c >> 1) & 1, (c >> 2) & 1] as const);
/** The cell's 12 edges, as pairs of corners. */
const EDGES = [
  [0, 1],
  [2, 3],
  [4, 5],
  [6, 7],
  [0, 2],
  [1, 3],
  [4, 6],
  [5, 7],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
] as const;

/** The surface of `volume` where its distance is `level`. */
export function volumeSurface(volume: VolumeBakeResult, level: number): VolumeSurface {
  const [nx, ny, nz] = volume.size;
  const cell = [0, 1, 2].map(
    (axis) =>
      ((volume.boxMax[axis] as number) - (volume.boxMin[axis] as number)) /
      (volume.size[axis] as number),
  );
  const value = (i: number, j: number, k: number): number =>
    ((volume.texels[i + nx * (j + ny * k)] as number) / 255) * volume.scale + volume.bias - level;
  const centre = (index: number, axis: number): number =>
    (volume.boxMin[axis] as number) + (index + 0.5) * (cell[axis] as number);

  const cells: readonly [number, number, number] = [nx - 1, ny - 1, nz - 1];
  const vertexOf = new Int32Array(Math.max(0, cells[0] * cells[1] * cells[2])).fill(-1);
  const cellIndex = (i: number, j: number, k: number): number => i + cells[0] * (j + cells[1] * k);
  const positions: number[] = [];
  const normals: number[] = [];
  for (let k = 0; k < cells[2]; k++) {
    for (let j = 0; j < cells[1]; j++) {
      for (let i = 0; i < cells[0]; i++) {
        const corner = CORNERS.map(([x, y, z]) => value(i + x, j + y, k + z));
        const sum = [0, 0, 0];
        let crossings = 0;
        for (const [a, b] of EDGES) {
          const va = corner[a] as number;
          const vb = corner[b] as number;
          if (va < 0 === vb < 0) {
            continue;
          }
          const share = va / (va - vb);
          for (let axis = 0; axis < 3; axis++) {
            const from = (CORNERS[a] as readonly number[])[axis] as number;
            const to = (CORNERS[b] as readonly number[])[axis] as number;
            sum[axis] = (sum[axis] as number) + from + (to - from) * share;
          }
          crossings++;
        }
        if (crossings === 0) {
          continue;
        }
        vertexOf[cellIndex(i, j, k)] = positions.length / 3;
        const index = [i, j, k];
        for (let axis = 0; axis < 3; axis++) {
          const at = (index[axis] as number) + (sum[axis] as number) / crossings;
          positions.push(centre(at, axis));
        }
        // The gradient over the cell: on each axis, the far face's corners less the near face's.
        const gradient = [0, 1, 2].map(
          (axis) =>
            CORNERS.reduce(
              (total, offsets, c) => total + (offsets[axis] === 1 ? 1 : -1) * (corner[c] as number),
              0,
            ) / (cell[axis] as number),
        );
        const length = Math.hypot(...gradient) || 1;
        normals.push(...gradient.map((component) => component / length));
      }
    }
  }

  const indices: number[] = [];
  const size = [nx, ny, nz];
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const point = [i, j, k];
        const here = value(i, j, k);
        for (let axis = 0; axis < 3; axis++) {
          const next = [...point];
          next[axis] = (next[axis] as number) + 1;
          if ((next[axis] as number) >= (size[axis] as number)) {
            continue;
          }
          if (here < 0 === value(next[0] as number, next[1] as number, next[2] as number) < 0) {
            continue;
          }
          // The 4 cells around this edge: back along each of the other two axes, or not.
          const b = (axis + 1) % 3;
          const c = (axis + 2) % 3;
          const quad = [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ].map(([db, dc]) => {
            const at = [...point];
            at[b] = (at[b] as number) - (db as number);
            at[c] = (at[c] as number) - (dc as number);
            const inside = at.every(
              (coordinate, dimension) =>
                coordinate >= 0 && coordinate < (cells[dimension] as number),
            );
            return inside
              ? (vertexOf[cellIndex(at[0] as number, at[1] as number, at[2] as number)] as number)
              : -1;
          });
          if (quad.some((vertex) => vertex < 0)) {
            continue;
          }
          const [q0, q1, q2, q3] = quad as [number, number, number, number];
          // Wound to face from inside to outside.
          if (here < 0) {
            indices.push(q0, q1, q2, q0, q2, q3);
          } else {
            indices.push(q0, q2, q1, q0, q3, q2);
          }
        }
      }
    }
  }
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    indices: Uint32Array.from(indices),
  };
}
