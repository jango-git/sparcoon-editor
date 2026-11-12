/**
 * The timeline's right-hand inspector: renders whatever the current selection needs. Pure over its
 * {@link InspectorContext}; the panel calls it on every selection change.
 */

import type { FXEmissionBasis } from "sparcoon";
import { asEmissionBasis, FX_EMISSION_BASES } from "sparcoon/editor";

import { reactionSourceCandidates } from "../../domain/deathReactions";
import { t, type TKey } from "../../i18n";
import {
  DEFAULT_PLAY_DURATION,
  moveTrackKeyframes,
  moveTransformKeyframes,
  removeEvent,
  removeKeyframe,
  removeReaction,
  removeTransformKeyframe,
  setKeyframeEase,
  setKeyframeValue,
  setTransformKeyframeEase,
  setTransformKeyframeValue,
  type SpawnActionPatch,
  updateEvent,
  updateReaction,
} from "../../model/commands";
import type { DeathReaction, EmitterDoc, SpawnAction } from "../../model/editorState";
import { frameOf, timeOfFrame } from "../../model/frames";
import type { Store } from "../../model/store";
import { clearChildren } from "../dom";
import {
  channelValueEditor,
  dropdownField,
  durationField,
  easeField,
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
  inspector.append(
    ...spawnActionFields(
      event,
      (patch, live) => updateEvent(store, emitterId, ref.id, patch, live),
      { kind: "event", commitBasis: (over) => updateEvent(store, emitterId, ref.id, { over }) },
    ),
  );
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
    easeField(found.key.ease, (ease) => setKeyframeEase(store, ref.entity, ref.id, ease)),
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
    easeField(found.key.ease, (ease) => setTransformKeyframeEase(store, ref.entity, ref.id, ease)),
  );
  inspector.append(
    inspectorRemove(
      () => removeTransformKeyframe(store, ref.entity, ref.id),
      t("timeline.removeItemTip"),
    ),
  );
}

/** Each basis a play's rate counts per, as the inspector names it. */
const BASIS_LABEL: Readonly<Record<FXEmissionBasis, TKey>> = {
  time: "timeline.overTime",
  distance: "timeline.overDistance",
};

/** What the rate field says it counts, by the play's basis. */
const RATE_TIP: Readonly<Record<FXEmissionBasis, TKey>> = {
  time: "timeline.rateTip",
  distance: "timeline.rateOverDistanceTip",
};

/** A partial edit of a spawn action, previewed live (no history entry) or committed. */
type SpawnActionCommit = (patch: SpawnActionPatch, live: boolean) => void;

/**
 * Where a spawn action lives, which decides how its play may run: an event's may run forever and
 * count over distance; a reaction's lasts at least a frame and counts over time (it spawns from
 * where a particle died, which does not move).
 */
type SpawnActionHost =
  | { readonly kind: "event"; readonly commitBasis: (over: FXEmissionBasis) => void }
  | { readonly kind: "reaction" };

/** The row picking what a play's rate counts per. */
function basisField(over: FXEmissionBasis, commit: (over: FXEmissionBasis) => void): HTMLElement {
  return dropdownField(
    t("timeline.over"),
    FX_EMISSION_BASES.map((value) => ({ value, label: t(BASIS_LABEL[value]) })),
    over,
    (value) => {
      const basis = asEmissionBasis(value);
      if (basis !== undefined) {
        commit(basis);
      }
    },
    t("timeline.overTip"),
  );
}

/**
 * The fields of a spawn action - an event's or a reaction's (see {@link SpawnActionHost}): the burst
 * count, or the play rate, what it counts per, and duration.
 */
function spawnActionFields(
  action: SpawnAction,
  commit: SpawnActionCommit,
  host: SpawnActionHost,
): HTMLElement[] {
  if (action.kind === "burst") {
    return [
      inspectorField(
        t("field.count"),
        action.count,
        { min: 0, step: 1, precision: 0 },
        (count) => commit({ count }, false),
        t("timeline.countTip"),
        (count) => commit({ count }, true),
      ),
    ];
  }
  const rate = inspectorField(
    t("field.rate"),
    action.rate,
    { min: 0, step: 0.1 },
    (value) => commit({ rate: value }, false),
    t(RATE_TIP[action.over ?? "time"]),
    (value) => commit({ rate: value }, true),
  );
  const duration =
    host.kind === "event"
      ? durationField(
          action.duration,
          (value) => commit({ duration: value }, false),
          () => commit({ duration: action.duration <= 0 ? DEFAULT_PLAY_DURATION : 0 }, false),
          t("timeline.durationTip"),
          (value) => commit({ duration: value }, true),
        )
      : inspectorField(
          t("field.duration"),
          action.duration,
          { min: 0, step: 0.1 },
          (value) => commit({ duration: value }, false),
          t("timeline.reactionDurationTip"),
          (value) => commit({ duration: value }, true),
        );
  return host.kind === "event"
    ? [rate, basisField(action.over ?? "time", host.commitBasis), duration]
    : [rate, duration];
}

/**
 * The inspector for one death reaction of `target` (picked from its timeline sub-row, not the time
 * selection): what it reacts to - any emitter that closes no cycle - and its action.
 */
export function renderReactionInspector(
  inspector: HTMLElement,
  store: Store,
  target: EmitterDoc,
  reaction: DeathReaction,
): void {
  clearChildren(inspector);
  const emitters = store.getSource().scene.emitters;
  inspector.append(
    inspectorTitle(t(reaction.kind === "burst" ? "timeline.burstOnDeath" : "timeline.playOnDeath")),
    dropdownField(
      t("timeline.reactionSource"),
      reactionSourceCandidates(emitters, target.id, reaction.id).map((emitter) => ({
        value: emitter.id,
        label: emitter.name,
      })),
      reaction.source,
      (source) => updateReaction(store, target.id, reaction.id, { source }),
      t("timeline.reactionSourceTip"),
    ),
    ...spawnActionFields(
      reaction,
      (patch, live) => updateReaction(store, target.id, reaction.id, patch, live),
      { kind: "reaction" },
    ),
    inspectorRemove(
      () => removeReaction(store, target.id, reaction.id),
      t("timeline.removeReactionTip"),
    ),
  );
}
