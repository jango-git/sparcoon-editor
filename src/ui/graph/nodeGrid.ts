/**
 * One CSS grid with five columns: input dot, input label, center control, output label, output dot.
 * A cell gives its start column (1-based) and optional `colEnd` (-1 is the grid end).
 */

import { createElement } from "../dom";

export const COL_IN_DOT = 1;
export const COL_IN_LABEL = 2;
export const COL_CENTER = 3;
export const COL_OUT_LABEL = 4;
export const COL_OUT_DOT = 5;
export const COL_END = -1;

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
