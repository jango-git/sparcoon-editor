/**
 * The rows of the viewport tabs' settings panels (Lighting, Scene, Gizmo, SDF): a label and one
 * control in the panel's shared two-column grid (`.preview-settings`).
 */

import { NumberControl } from "../components/numberControl";
import { createElement } from "../dom";
import { field } from "../primitives/field";

/** A settings row plus a resync hook, so a store reset (preset apply / project load) can push the
 *  restored value into the control that renders it, not just the store behind it. */
export interface SettingsRow<TValue> {
  readonly element: HTMLElement;
  readonly setValue: (value: TValue) => void;
}

/** The class pair every settings row shares. */
export const SETTINGS_ROW = {
  rowClassName: "preview-settings__row",
  labelClassName: "preview-settings__label",
} as const;

/** A labelled scrubbable numeric row. */
export function numberRow(
  label: string,
  initial: number,
  bounds: { min?: number; max?: number; step?: number; precision?: number },
  onChange: (value: number) => void,
): SettingsRow<number> {
  const control = new NumberControl({ value: initial, ...bounds, onChange });
  return {
    element: field(label, control.element, SETTINGS_ROW),
    setValue: (value) => control.setValue(value),
  };
}

/** A muted subsection caption spanning the tab's full width (grid-column set in CSS). */
export function sectionTitle(label: string): HTMLElement {
  return createElement("div", {
    className: "preview-settings__section-title",
    textContent: label,
  });
}

/** Hides every row in `rows` entirely (not just greyed), or restores them. */
export function setRowsHidden(rows: readonly HTMLElement[], hidden: boolean): void {
  for (const row of rows) {
    row.classList.toggle("preview-settings__row--hidden", hidden);
  }
}
