/**
 * The timeline inspector's building blocks: titles, hints, the Remove button, and the labelled
 * scrubbable number / vector editors. Pure DOM factories over {@link NumberControl}.
 */

import { t } from "../../i18n";
import type { ChannelValue } from "../../model/commands";
import type { TransformChannel } from "../../model/transform";
import { NumberControl } from "../components/numberControl";
import { attachTooltip } from "../components/tooltip";
import { createToggleButton } from "../components/toggleButton";
import { createElement } from "../dom";
import { timelineIcons } from "../icons";
import { field } from "../primitives/field";
import { channelFromDisplay, channelToDisplay } from "./transformChannel";

export function inspectorTitle(text: string): HTMLElement {
  return createElement("div", { className: "timeline-inspector__title", textContent: text });
}

export function inspectorHint(text: string): HTMLElement {
  return createElement("div", { className: "timeline-inspector__hint", textContent: text });
}

export function inspectorRemove(onClick: () => void, description?: string): HTMLElement {
  const button = createElement("button", {
    className: "timeline-inspector__remove",
    textContent: t("timeline.remove"),
  });
  button.type = "button";
  button.addEventListener("click", onClick);
  if (description !== undefined) {
    attachTooltip(button, t("timeline.remove"), description);
  }
  return button;
}

/** Per-field numeric bounds/step for the scrubbable inspector controls. */
export interface FieldOptions {
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly precision?: number;
}

/** A labelled scrubbable {@link NumberControl} row for the inspector. `live`, if given, previews
 *  every intermediate scrub step without touching undo history; omit for no live preview at all. */
export function inspectorField(
  label: string,
  value: number,
  options: FieldOptions,
  commit: (value: number) => void,
  description?: string,
  live?: (value: number) => void,
): HTMLElement {
  const control = new NumberControl({ value, ...options, onChange: commit, live });
  const row = field(label, control.element, {
    tag: "label",
    rowClassName: "timeline-inspector__row",
    labelClassName: "timeline-inspector__label",
  });
  if (description !== undefined) {
    attachTooltip(row, label, description);
  }
  return row;
}

/**
 * The duration field's "infinite" toggle sits left of the control as a sibling via field()'s array
 * form, so the [label]|[controls] boundary never moves. Infinite mutes the control (grayed, held at 0).
 */
export function durationField(
  duration: number,
  onDurationChange: (value: number) => void,
  onToggleInfinite: () => void,
  description?: string,
  onDurationLiveChange?: (value: number) => void,
): HTMLElement {
  const infinite = duration <= 0;
  const control = new NumberControl({
    value: duration,
    min: 0,
    step: 0.1,
    disabled: infinite,
    onChange: onDurationChange,
    live: onDurationLiveChange,
  });
  const toggle = createToggleButton({
    baseClassName: "timeline-inspector__infinite",
    activeClassName: "is-active",
    glyph: timelineIcons.infinite,
    value: infinite,
    title: t("timeline.infinitePlay"),
    description: infinite ? t("timeline.infinitePlayOffTip") : t("timeline.infinitePlayOnTip"),
    stopPropagation: true,
    onChange: onToggleInfinite,
  }).element;
  const row = field(t("field.duration"), [toggle, control.element], {
    tag: "label",
    rowClassName: "timeline-inspector__row",
    labelClassName: "timeline-inspector__label",
  });
  if (description !== undefined) {
    attachTooltip(row, t("field.duration"), description);
  }
  return row;
}

/** i18n keys for the component axis letters of a stacked vector editor. */
const AXIS_KEYS = ["axis.x", "axis.y", "axis.z", "axis.w"] as const;

/** A labelled vector editor, one row per component; editing any component commits the whole vector.
 *  `live`, if given, previews every intermediate scrub step without touching undo history. */
function vectorRow(
  label: string,
  components: readonly number[],
  options: FieldOptions,
  commit: (values: number[]) => void,
  description?: string,
  live?: (values: number[]) => void,
): HTMLElement {
  const current = [...components];
  const componentRows = current.map((component, index) => {
    const control = new NumberControl({
      value: component,
      ...options,
      onChange: (next): void => {
        current[index] = next;
        commit([...current]);
      },
      live:
        live === undefined
          ? undefined
          : (next): void => {
              // A component's own live preview reports the whole vector with its siblings still at
              // their last committed value (mirrors nodeWidgets.ts's identical vectorField choice).
              const preview = [...current];
              preview[index] = next;
              live(preview);
            },
    });
    const axisKey = AXIS_KEYS[index];
    const axisLabel = axisKey !== undefined ? t(axisKey) : `${index}`;
    const componentRow = field(axisLabel, control.element, {
      rowClassName: "timeline-inspector__vec-comp",
      labelClassName: "timeline-inspector__axis",
    });
    if (description !== undefined) {
      attachTooltip(componentRow, `${label} ${axisLabel}`, description);
    }
    return componentRow;
  });
  const vector = createElement("div", { className: "timeline-inspector__vector" }, componentRows);
  const group = field(label, vector, {
    rowClassName: "timeline-inspector__vector-group",
    labelClassName: "timeline-inspector__label",
  });
  if (description !== undefined) {
    attachTooltip(group, label, description);
  }
  return group;
}

/** A value editor for a Timeline Value keyframe: one field for a scalar, a row for a vector.
 *  `live`, if given, previews every intermediate scrub step without touching undo history. */
export function valueEditor(
  value: number | readonly number[],
  commit: (value: number | readonly number[]) => void,
  description?: string,
  live?: (value: number | readonly number[]) => void,
): HTMLElement {
  if (typeof value === "number") {
    return inspectorField(t("field.value"), value, { step: 0.1 }, commit, description, live);
  }
  return vectorRow(
    t("field.value"),
    value,
    { step: 0.1 },
    (values) => commit(values),
    description,
    live === undefined ? undefined : (values): void => live(values),
  );
}

/**
 * A transform-keyframe value editor: position/scale edit raw components; rotation decomposes to
 * Euler degrees for editing and recomposes to a quaternion on commit. `live`, if given, previews
 * every intermediate scrub step without touching undo history.
 */
export function channelValueEditor(
  channel: TransformChannel,
  value: number | readonly number[],
  commit: (value: ChannelValue) => void,
  description?: string,
  live?: (value: ChannelValue) => void,
): HTMLElement {
  const isRotation = channel === "rotation";
  return vectorRow(
    isRotation ? t("timeline.euler") : t("field.value"),
    channelToDisplay(channel, value),
    isRotation ? { step: 1, precision: 2 } : { step: 0.1 },
    (values) => commit(channelFromDisplay(channel, values)),
    description,
    live === undefined ? undefined : (values): void => live(channelFromDisplay(channel, values)),
  );
}
