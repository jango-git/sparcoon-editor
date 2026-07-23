/**
 * Timeline formatting helpers: a time's fraction along the lane, and the marker-tooltip / event
 * strings. Rotation is always surfaced as Euler degrees (the key stores a quaternion).
 */

import { t } from "../../i18n";
import type { TimelineEvent } from "../../model/editorState";
import type { TransformChannel } from "../../model/transform";
import { clamp } from "../primitives/math";
import { channelToDisplay } from "./transformChannel";

/**
 * The lane covers a padded window beyond the authored [0, duration] (RANGE_PAD before 0 and past
 * the end); every time<->lane-position mapping goes through the helpers below to stay consistent.
 */
const RANGE_PAD = 0.2;

/** The lane's left-edge time (seconds), i.e. the padded window start (negative). */
export function rangeStart(total: number): number {
  return -total * RANGE_PAD;
}

/** The full time span the lane covers (seconds): the authored duration plus both pads. */
export function rangeSpan(total: number): number {
  return total * (1 + 2 * RANGE_PAD);
}

/** A time's fraction along the padded lane, clamped to `[0, 1]`. */
export function fraction(time: number, total: number): number {
  const span = rangeSpan(total);
  return span > 0 ? clamp((time - rangeStart(total)) / span, 0, 1) : 0;
}

/** The time (seconds) at fraction `f` [0, 1] across the padded lane - the inverse of {@link fraction}. */
export function timeAtFraction(fractionValue: number, total: number): number {
  return rangeStart(total) + fractionValue * rangeSpan(total);
}

/** A duration (seconds) as a fraction of the lane's width (a play event's span, a drag delta). */
export function spanFraction(seconds: number, total: number): number {
  const span = rangeSpan(total);
  return span > 0 ? seconds / span : 0;
}

export function describeEvent(event: TimelineEvent): string {
  if (event.kind === "burst") {
    return t("timeline.burstTooltip", { t: trimNumber(event.time), count: String(event.count) });
  }
  // A play with duration 0 emits forever (task 2) - its tooltip says so instead of "0s".
  if (event.duration <= 0) {
    return t("timeline.playInfiniteTooltip", {
      t: trimNumber(event.time),
      rate: trimNumber(event.rate),
    });
  }
  return t("timeline.playTooltip", {
    t: trimNumber(event.time),
    rate: trimNumber(event.rate),
    duration: trimNumber(event.duration),
  });
}

export function formatValue(value: number | readonly number[]): string {
  if (typeof value === "number") {
    return trimNumber(value);
  }
  return `[${value.map(trimNumber).join(", ")}]`;
}

/** A transform keyframe value for a marker tooltip - rotation shown as Euler degrees. */
export function formatChannel(
  channel: TransformChannel,
  value: number | readonly number[],
): string {
  if (channel === "rotation") {
    return `[${channelToDisplay(channel, value).map(trimNumber).join(", ")}]deg`;
  }
  return formatValue(value);
}

function trimNumber(value: number): string {
  return Number.parseFloat(value.toFixed(3)).toString();
}
