/**
 * The node canvas grid. One cell is {@link GRID_SIZE} px in graph coordinates and
 * matches the dotted background tile (see `.graph` in graph.css). Node positions
 * snap to it and node sizes are whole multiples of it, so nodes sit exactly on the
 * grid.
 */

export const GRID_SIZE = 24;

/** Rounds a graph coordinate to the nearest grid line. */
export function snapToGrid(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}
