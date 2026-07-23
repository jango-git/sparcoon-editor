/**
 * Row-content builders for the timeline: draggable markers, read-only summary diamonds, and label
 * cells. Pure factories - drag/selection come in as callbacks, decoupled from the panel's state.
 */

import { t, type TKey } from "../../i18n";
import type { EmitterDoc, Keyframe } from "../../model/editorState";
import { emitterEntity, type SceneEntity } from "../../model/entity";
import { frameOf } from "../../model/frames";
import type { TransformChannel } from "../../model/transform";
import { attachTooltip } from "../components/tooltip";
import { createElement } from "../dom";
import { timelineIcons, viewportIcons } from "../icons";
import { clamp } from "../primitives/math";
import {
  describeEvent,
  formatChannel,
  formatValue,
  fraction,
  spanFraction,
} from "./timelineFormat";
import { beginRename, rowActionButton, timelineIcon } from "./timelineRowLabel";
import type { ItemPointerHandler, ItemRef, Marker } from "./timelineTypes";

/** The i18n key for each transform channel label (rotation is edited/displayed as Euler degrees). */
export const CHANNEL_LABEL: Record<TransformChannel, TKey> = {
  position: "field.position",
  rotation: "field.rotation",
  scale: "field.scale",
};

/** Draggable markers for a Timeline Value track's keyframes. */
export function keyframeMarkers(
  entity: SceneEntity,
  track: EmitterDoc["tracks"][number],
  total: number,
  fps: number,
  onItemPointerDown: ItemPointerHandler,
): Marker[] {
  const output: Marker[] = [];
  for (const key of track.keys) {
    const dot = createElement("div", { className: "timeline-key" });
    dot.style.left = `${fraction(key.time, total) * 100}%`;
    attachTooltip(
      dot,
      t("timeline.keyframe"),
      t("timeline.keyframeTooltip", {
        track: track.name,
        frame: String(frameOf(key.time, fps)),
        value: formatValue(key.value),
      }),
      "pointer",
    );
    const ref: ItemRef = { entity, kind: "key", id: key.id };
    dot.addEventListener("pointerdown", (down) => onItemPointerDown(down, ref));
    output.push({ element: dot, ref });
  }
  return output;
}

/** Draggable markers for one transform channel's keyframes on an entity. */
export function transformKeyMarkers(
  entity: SceneEntity,
  channel: TransformChannel,
  keys: readonly Keyframe[],
  total: number,
  fps: number,
  onItemPointerDown: ItemPointerHandler,
): Marker[] {
  const output: Marker[] = [];
  for (const key of keys) {
    const dot = createElement("div", { className: "timeline-key" });
    dot.style.left = `${fraction(key.time, total) * 100}%`;
    attachTooltip(
      dot,
      t(CHANNEL_LABEL[channel]),
      t("timeline.transformKeyTooltip", {
        channel: t(CHANNEL_LABEL[channel]),
        frame: String(frameOf(key.time, fps)),
        value: formatChannel(channel, key.value),
      }),
      "pointer",
    );
    const ref: ItemRef = { entity, kind: "transformKey", channel, id: key.id };
    dot.addEventListener("pointerdown", (down) => onItemPointerDown(down, ref));
    output.push({ element: dot, ref });
  }
  return output;
}

/** Draggable markers for an emitter's spawn events (burst dots / play bars). */
export function eventMarkers(
  emitter: EmitterDoc,
  total: number,
  onItemPointerDown: ItemPointerHandler,
): Marker[] {
  const entity = emitterEntity(emitter.id);
  const output: Marker[] = [];
  for (const event of emitter.events) {
    const timeFraction = fraction(event.time, total);
    const marker = createElement("div", {
      className:
        event.kind === "burst"
          ? "timeline-event timeline-event--burst"
          : "timeline-event timeline-event--play",
    });
    marker.style.left = `${timeFraction * 100}%`;
    if (event.kind === "play") {
      if (event.duration <= 0) {
        // An infinite play runs PAST the timeline end to the lane's right edge.
        marker.classList.add("timeline-event--infinite");
        marker.style.width = `${(1 - timeFraction) * 100}%`;
      } else {
        // A finite play is clipped to the timeline end, not the padded lane edge.
        const windowEnd = fraction(total, total);
        const span = clamp(spanFraction(event.duration, total), 0, windowEnd - timeFraction);
        marker.style.width = `${span * 100}%`;
      }
    }
    attachTooltip(
      marker,
      event.kind === "burst" ? t("timeline.burst") : t("timeline.play"),
      describeEvent(event),
      "pointer",
    );
    const ref: ItemRef = { entity, kind: "event", id: event.id };
    marker.addEventListener("pointerdown", (down) => onItemPointerDown(down, ref));
    output.push({ element: marker, ref });
  }
  return output;
}

/**
 * Mirrors every keyframe from `tracks` onto a header lane as small read-only diamonds - visible
 * even while the object is collapsed. Not registered as markers, so purely visual (not selectable).
 */
export function appendSummaryKeys(
  lane: HTMLElement,
  tracks: readonly { readonly keys: readonly Keyframe[] }[],
  total: number,
): void {
  for (const track of tracks) {
    for (const key of track.keys) {
      const dot = createElement("div", { className: "timeline-key timeline-key--summary" });
      dot.style.left = `${fraction(key.time, total) * 100}%`;
      lane.append(dot);
    }
  }
}

/**
 * A top-level entity label (the VFX group): icon + name (double-click to rename inline - one of
 * three surfaces editing the project name, see {@link VfxDoc}); click selects/expands.
 */
export function buildEntityLabel(
  entity: SceneEntity,
  name: string,
  onSelect: (entity: SceneEntity) => void,
  onRename: (name: string) => void,
): HTMLElement {
  const nameElement = createElement("span", { className: "timeline-row__name", textContent: name });
  nameElement.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    beginRename(name, onRename, nameElement);
  });
  const label = createElement("div", { className: "timeline-row__label" }, [
    timelineIcon(viewportIcons.group),
    nameElement,
  ]);
  label.addEventListener("click", () => onSelect(entity));
  return label;
}

/**
 * The live toggle excludes the channel/param from the TS export (left to the exported effect's
 * live-update API instead). `locked` styling is CSS-only (`is-locked`), never the native `disabled`
 * attribute - a disabled button drops `mouseenter` in every browser, killing the tooltip that
 * explains WHY it's locked; the click handler no-ops instead.
 */
function buildLiveToggle(live: boolean, locked: boolean, onToggle: () => void): HTMLElement {
  const active = locked || live;
  const button = rowActionButton(
    timelineIcons.live,
    locked ? t("timeline.fakeLocked") : t(active ? "timeline.unmarkFake" : "timeline.markFake"),
    locked
      ? t("timeline.fakeLockedTip")
      : t(active ? "timeline.unmarkFakeTip" : "timeline.markFakeTip"),
    () => {
      if (!locked) {
        onToggle();
      }
    },
  );
  button.classList.toggle("is-live", active);
  button.classList.toggle("is-locked", locked);
  return button;
}

/**
 * The label cell for a transform channel sub-row: name, add-key button, live toggle. Clicking the
 * label (not a child button, which stops propagation) selects the owner.
 */
export function buildChannelLabel(
  entity: SceneEntity,
  channel: TransformChannel,
  live: boolean,
  onSelect: (entity: SceneEntity) => void,
  addKey: () => void,
  onToggleLive: () => void,
): HTMLElement {
  const label = createElement("div", { className: "timeline-row__label timeline-track__label" }, [
    createElement("span", { className: "timeline-track__marker" }),
    createElement("span", {
      className: "timeline-row__name",
      textContent: t(CHANNEL_LABEL[channel]),
    }),
    rowActionButton(timelineIcons.addKey, t("timeline.addKey"), t("timeline.addKeyTip"), addKey),
    buildLiveToggle(live, entity.kind === "vfx", onToggleLive),
  ]);
  label.addEventListener("click", () => onSelect(entity));
  return label;
}

/**
 * The label cell for a Timeline Value sub-row: name, add-key button (bakes the caret value), live
 * toggle. Clicking the label (not a child button) selects the owner.
 */
export function buildTrackLabel(
  entity: SceneEntity,
  name: string,
  live: boolean,
  onSelect: (entity: SceneEntity) => void,
  addKey: () => void,
  onToggleLive: () => void,
): HTMLElement {
  const label = createElement("div", { className: "timeline-row__label timeline-track__label" }, [
    createElement("span", { className: "timeline-track__marker" }),
    createElement("span", { className: "timeline-row__name", textContent: name }),
    rowActionButton(timelineIcons.addKey, t("timeline.addKey"), t("timeline.addKeyTip"), addKey),
    buildLiveToggle(live, false, onToggleLive),
  ]);
  label.addEventListener("click", () => onSelect(entity));
  return label;
}
