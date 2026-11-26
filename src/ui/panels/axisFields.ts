/** A vector's fields: one scrubbable field per axis, stacked under a caption or side by side in a
 *  settings row. */

import { t } from "../../i18n";
import { NumberControl } from "../components/numberControl";
import { createElement } from "../dom";
import { field } from "../primitives/field";
import { SETTINGS_ROW } from "./settingsRows";

/** One number field per axis. */
export type AxisTriplet = [NumberControl, NumberControl, NumberControl];

/** Three fields calling `onChange` at the end of an edit and `live` on each scrub step. */
export function axisTriplet(
  options: { step?: number; precision?: number; compact?: boolean },
  onChange: () => void,
  live: () => void,
): AxisTriplet {
  const make = (): NumberControl => new NumberControl({ value: 0, ...options, onChange, live });
  return [make(), make(), make()];
}

/** The fields' values, one per axis. */
export function readTriplet(controls: AxisTriplet): [number, number, number] {
  return [controls[0].value, controls[1].value, controls[2].value];
}

/** Shows `values` in the fields, one per axis. */
export function setTriplet(controls: AxisTriplet, values: readonly number[]): void {
  controls[0].setValue(values[0] ?? 0);
  controls[1].setValue(values[1] ?? 0);
  controls[2].setValue(values[2] ?? 0);
}

/** A labelled channel block with its three axis components stacked one per row. */
export function axisSection(label: string, controls: AxisTriplet): HTMLElement {
  return fieldSection(label, [
    [t("axis.x"), controls[0].element],
    [t("axis.y"), controls[1].element],
    [t("axis.z"), controls[2].element],
  ]);
}

/** A captioned block of fields stacked one per row, each behind its short label. */
export function fieldSection(
  label: string,
  rows: readonly (readonly [string, HTMLElement])[],
): HTMLElement {
  return createElement("div", { className: "viewport-transform__section" }, [
    createElement("div", { className: "viewport-transform__section-title", textContent: label }),
    ...rows.map(([rowLabel, element]) =>
      field(rowLabel, element, {
        rowClassName: "viewport-transform__comp",
        labelClassName: "viewport-transform__axis",
      }),
    ),
  ]);
}

/** A settings row of `label` with the three fields side by side (make them `compact`). */
export function axisRow(label: string, controls: AxisTriplet): HTMLElement {
  return field(
    label,
    createElement(
      "div",
      { className: "preview-settings__value" },
      controls.map((control) => control.element),
    ),
    SETTINGS_ROW,
  );
}
