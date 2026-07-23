/**
 * The generic grid-row layout mechanism a node card's body is built from: one CSS grid whose five
 * columns line up across every row - `[input dot][input label][center control][output label]
 * [output dot]`. A cell names its start column (1-based); an optional `colEnd` spans to a later
 * line, where `-1` is the grid's end. Sharing one grid keeps dots, names and controls aligned
 * between rows. No knowledge of nodes/params - reusable wherever a row needs this layout.
 */

import { createElement } from "../dom";

export const COL_IN_DOT = 1;
export const COL_IN_LABEL = 2;
export const COL_CENTER = 3;
export const COL_OUT_LABEL = 4;
export const COL_OUT_DOT = 5;
export const COL_END = -1;

/** Node width bounds in grid cells: content-sized, then snapped up into this range. */
export const MIN_NODE_CELLS = 6;
export const MAX_NODE_CELLS = 16;

/**
 * Slack (px) added to the measured natural width before snapping to whole cells. When the content
 * lands flush on a `GRID_SIZE` boundary, an `auto` label track with `overflow:hidden` (0 automatic
 * minimum) sub-pixel-clips to an ellipsis despite fitting; this pushes such a node to the next whole
 * cell. Applied inside the cell rounding, so the width stays a whole multiple of `GRID_SIZE` (the
 * shared layout grid - node placement/snapping is unaffected).
 */
export const NODE_WIDTH_CLIP_GUARD = 2;

/** One placed grid item: an element, its start column and optional span end (`-1` = grid end). */
export interface Cell {
  readonly element: HTMLElement;
  readonly col: number;
  readonly colEnd?: number;
}

/** One body row: its cells and how many grid rows it is tall (default 1, e.g. 4 for a gradient). */
export interface NodeRow {
  readonly cells: readonly Cell[];
  readonly span?: number;
}

/** Lays the body rows into one CSS grid, placing each cell by its column span and row. */
export function mountBody(rows: readonly NodeRow[]): HTMLElement {
  const body = createElement("div", { className: "node__body" });
  let rowLine = 1;
  for (const row of rows) {
    const span = row.span ?? 1;
    for (const cell of row.cells) {
      cell.element.style.gridColumn =
        cell.colEnd !== undefined ? `${cell.col} / ${cell.colEnd}` : `${cell.col}`;
      cell.element.style.gridRow = span > 1 ? `${rowLine} / span ${span}` : `${rowLine}`;
      body.append(cell.element);
    }
    rowLine += span;
  }
  return body;
}

/** Wraps a control in a centre-lane cell that swallows pointerdown (so editing never drags the node). */
export function centerCell(control: HTMLElement): HTMLElement {
  const cell = createElement("div", { className: "node__center" }, [control]);
  cell.addEventListener("pointerdown", (event) => event.stopPropagation());
  return cell;
}
