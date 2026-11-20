/**
 * A labelled row: a caption beside a control. Layout only. The caller builds and keeps the control.
 * An axis sub-row is a field whose label is the axis letter.
 */

import { createElement } from "../dom";

export interface FieldLayout {
  /** Row element tag - `label` wires a native click-to-focus, `span` nests inside another row. Default `div`. */
  readonly tag?: "div" | "label" | "span";
  /** The row element's class (the surface's `block__row`). */
  readonly rowClassName: string;
  /** The caption span's class (the surface's `block__label`). */
  readonly labelClassName: string;
  /** Place the caption after the control(s) rather than before (the stats readout). Default false. */
  readonly labelAfter?: boolean;
}

/** A caption `label` beside `control` (or several controls), laid out per `layout`. */
export function field(
  label: string,
  control: HTMLElement | readonly HTMLElement[],
  layout: FieldLayout,
): HTMLElement {
  const caption = createElement("span", { className: layout.labelClassName, textContent: label });
  const controls = control instanceof HTMLElement ? [control] : control;
  const children = (layout.labelAfter ?? false) ? [...controls, caption] : [caption, ...controls];
  return createElement(layout.tag ?? "div", { className: layout.rowClassName }, children);
}
