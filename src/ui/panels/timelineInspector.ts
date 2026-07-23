/**
 * The timeline's right-hand inspector: renders whatever the current selection needs. Pure over its
 * {@link InspectorContext}; the panel calls it on every selection change.
 */

import {
  DEFAULT_PLAY_DURATION,
  moveTrackKeyframes,
  moveTransformKeyframes,
  removeEvent,
  removeKeyframe,
  removeTransformKeyframe,
  setKeyframeValue,
  setTransformKeyframeValue,
  updateEvent,
} from "../../model/commands";
import { t } from "../../i18n";
import { frameOf, timeOfFrame } from "../../model/frames";
import type { Store } from "../../model/store";
import { clearChildren } from "../dom";
import {
  channelValueEditor,
  durationField,
  inspectorField,
  inspectorHint,
  inspectorRemove,
  inspectorTitle,
  valueEditor,
} from "./timelineInspectorFields";
import { emitterIdOf, findEvent, findKeyframe, findTransformKey } from "./timelineQueries";
import { CHANNEL_LABEL } from "./timelineRows";
import type { ItemRef } from "./timelineTypes";

/** Inspector "Frame" field: whole frames, clamped at the timeline start. */
const FRAME_OPTIONS = { min: 0, step: 1, precision: 0 } as const;

export interface InspectorContext {
  readonly inspector: HTMLElement;
  readonly store: Store;
  readonly fps: () => number;
  /** Removes every selected item, then clears the selection (the multi-select bulk action). */
  readonly removeSelected: () => void;
}

/** Renders the inspector for the current selection: 0 = hint, >1 = count + remove, 1 = item editor. */
export function renderTimelineInspector(
  selection: ReadonlySet<string>,
  refByKey: ReadonlyMap<string, ItemRef>,
  ctx: InspectorContext,
): void {
  clearChildren(ctx.inspector);
  const keys = [...selection];
  if (keys.length === 0) {
    ctx.inspector.append(inspectorHint(t("timeline.selectHint")));
    return;
  }
  if (keys.length > 1) {
    ctx.inspector.append(
      inspectorTitle(t("timeline.selected", { count: keys.length })),
      inspectorRemove(ctx.removeSelected, t("timeline.removeItemTip")),
    );
    return;
  }
  const [key] = keys;
  if (key === undefined) {
    ctx.inspector.append(inspectorHint("-"));
    return;
  }
  const ref = refByKey.get(key);
  if (ref === undefined) {
    ctx.inspector.append(inspectorHint("-"));
    return;
  }
  if (ref.kind === "event") {
    renderEventInspector(ref, ctx);
  } else if (ref.kind === "transformKey") {
    renderTransformKeyframeInspector(ref, ctx);
  } else {
    renderKeyframeInspector(ref, ctx);
  }
}

function renderEventInspector(ref: ItemRef, ctx: InspectorContext): void {
  const { inspector, store, fps } = ctx;
  const emitterId = emitterIdOf(ref);
  const event = emitterId === undefined ? undefined : findEvent(store, emitterId, ref.id);
  if (emitterId === undefined || event === undefined) {
    inspector.append(inspectorHint("-"));
    return;
  }
  inspector.append(
    inspectorTitle(event.kind === "burst" ? t("timeline.burst") : t("timeline.play")),
  );
  inspector.append(
    inspectorField(
      t("field.frame"),
      frameOf(event.time, fps()),
      FRAME_OPTIONS,
      (frame) => updateEvent(store, emitterId, ref.id, { time: timeOfFrame(frame, fps()) }),
      t("timeline.frameTip"),
      (frame) => updateEvent(store, emitterId, ref.id, { time: timeOfFrame(frame, fps()) }, true),
    ),
  );
  if (event.kind === "burst") {
    inspector.append(
      inspectorField(
        t("field.count"),
        event.count,
        { min: 0, step: 1, precision: 0 },
        (count) => updateEvent(store, emitterId, ref.id, { count }),
        t("timeline.countTip"),
        (count) => updateEvent(store, emitterId, ref.id, { count }, true),
      ),
    );
  } else {
    inspector.append(
      inspectorField(
        t("field.rate"),
        event.rate,
        { min: 0, step: 0.1 },
        (rate) => updateEvent(store, emitterId, ref.id, { rate }),
        t("timeline.rateTip"),
        (rate) => updateEvent(store, emitterId, ref.id, { rate }, true),
      ),
      durationField(
        event.duration,
        (durationValue) => updateEvent(store, emitterId, ref.id, { duration: durationValue }),
        () =>
          updateEvent(store, emitterId, ref.id, {
            duration: event.duration <= 0 ? DEFAULT_PLAY_DURATION : 0,
          }),
        t("timeline.durationTip"),
        (durationValue) => updateEvent(store, emitterId, ref.id, { duration: durationValue }, true),
      ),
    );
  }
  inspector.append(
    inspectorRemove(() => removeEvent(store, emitterId, ref.id), t("timeline.removeItemTip")),
  );
}

function renderKeyframeInspector(ref: ItemRef, ctx: InspectorContext): void {
  const { inspector, store, fps } = ctx;
  const found = findKeyframe(store, ref.entity, ref.id);
  if (found === undefined) {
    inspector.append(inspectorHint("-"));
    return;
  }
  inspector.append(inspectorTitle(found.track));
  inspector.append(
    inspectorField(
      t("field.frame"),
      frameOf(found.key.time, fps()),
      FRAME_OPTIONS,
      (frame) =>
        moveTrackKeyframes(store, ref.entity, [{ id: ref.id, time: timeOfFrame(frame, fps()) }]),
      t("timeline.frameTip"),
      (frame) =>
        moveTrackKeyframes(
          store,
          ref.entity,
          [{ id: ref.id, time: timeOfFrame(frame, fps()) }],
          true,
        ),
    ),
  );
  inspector.append(
    valueEditor(
      found.key.value,
      (value) => setKeyframeValue(store, ref.entity, ref.id, value),
      t("timeline.valueTip"),
      (value) => setKeyframeValue(store, ref.entity, ref.id, value, true),
    ),
  );
  inspector.append(
    inspectorRemove(() => removeKeyframe(store, ref.entity, ref.id), t("timeline.removeItemTip")),
  );
}

/** The inspector for a transform keyframe: frame, value (rotation as Euler degrees), and remove. */
function renderTransformKeyframeInspector(ref: ItemRef, ctx: InspectorContext): void {
  const { inspector, store, fps } = ctx;
  const channel = ref.channel;
  const found = channel === undefined ? undefined : findTransformKey(store, ref.entity, ref.id);
  if (channel === undefined || found === undefined) {
    inspector.append(inspectorHint("-"));
    return;
  }
  inspector.append(inspectorTitle(t(CHANNEL_LABEL[channel])));
  inspector.append(
    inspectorField(
      t("field.frame"),
      frameOf(found.key.time, fps()),
      FRAME_OPTIONS,
      (frame) =>
        moveTransformKeyframes(store, ref.entity, [
          { id: ref.id, time: timeOfFrame(frame, fps()) },
        ]),
      t("timeline.frameTip"),
      (frame) =>
        moveTransformKeyframes(
          store,
          ref.entity,
          [{ id: ref.id, time: timeOfFrame(frame, fps()) }],
          true,
        ),
    ),
  );
  inspector.append(
    channelValueEditor(
      channel,
      found.key.value,
      (value) => setTransformKeyframeValue(store, ref.entity, ref.id, value),
      t("timeline.valueTip"),
      (value) => setTransformKeyframeValue(store, ref.entity, ref.id, value, true),
    ),
  );
  inspector.append(
    inspectorRemove(
      () => removeTransformKeyframe(store, ref.entity, ref.id),
      t("timeline.removeItemTip"),
    ),
  );
}
