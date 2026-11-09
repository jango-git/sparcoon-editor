/**
 * Timeline agent edits: the scene-wide length and frame rate, each emitter's spawn events and death
 * reactions, and (from {@link KeyframeEdits}) keyframes. An emitter spawns nothing until an event fires, so these
 * are what make a capture show particles. Times and durations snap to the frame grid, as they do
 * in the editor.
 */

import {
  addBurstEvent,
  addPlayEvent,
  addReaction,
  removeEvent,
  removeReaction,
  setTimelineDuration,
  setTimelineFps,
  setLiveEvents,
  setTimelineLoop,
  updateEvent,
  updateReaction,
  type EventPatch,
  type ReactionPatch,
} from "../model/commands";
import { canReact } from "../domain/deathReactions";
import type { DeathReaction, SourceState, TimelineEvent } from "../model/editorState";
import { isRecord } from "../util/guards";
import { requireBoolean, requireFiniteNumber } from "./arguments.Internal";
import { resolveOwner } from "./address.Internal";
import { AgentError } from "./errors";
import { createKeyframeEdits, type KeyframeEdits } from "./keyframeEdits";
import type { EditSession } from "./transaction.Internal";

// The model's own patch shapes: a field the kind does not carry is refused here (requirePatch,
// requireReactionPatch), where the command would ignore it.
export type { EventPatch, ReactionPatch };

export interface TimelineEdits extends KeyframeEdits {
  setDuration(seconds: number): void;
  setFps(fps: number): void;
  /**
   * Loops the timeline (seamlessly), or plays it once and holds the last frame; the exported
   * effect then dispatches `"finished"` at the end.
   */
  setLoop(loop: boolean): void;
  /** Spawns `count` particles at once at `time`. Returns the event id. */
  addBurst(emitterId: string, time: number, count: number): string;
  /** Emits `rate` particles per second from `time` for `duration` seconds (0 = forever). */
  addPlay(emitterId: string, time: number, rate: number, duration: number): string;
  updateEvent(emitterId: string, eventId: string, patch: EventPatch): void;
  removeEvent(emitterId: string, eventId: string): void;
  /**
   * Plays the emitter's events in the editor only (`excluded: true`): previews and captures still
   * spawn from them, but the exported effect ships none, and the host code spawns through
   * `getEmitter(name).burst`/`play`. The events themselves stay either way.
   */
  setEventsExcluded(emitterId: string, excluded: boolean): void;
  /**
   * Spawns `count` particles on `emitterId` at every death of `sourceId`'s particles, from where
   * each died, one frame later. `sourceId` then simulates on the CPU. Refused when it would close a
   * cycle of reactions (an emitter reacting to itself included). Returns the reaction id.
   */
  addBurstOnDeath(emitterId: string, sourceId: string, count: number): string;
  /** Emits `rate` particles per second for `duration` seconds (above 0) on `emitterId` from where
   *  each of `sourceId`'s particles died. See {@link addBurstOnDeath}. */
  addPlayOnDeath(emitterId: string, sourceId: string, rate: number, duration: number): string;
  updateReaction(emitterId: string, reactionId: string, patch: ReactionPatch): void;
  removeReaction(emitterId: string, reactionId: string): void;
}

function requireEmitter(source: SourceState, emitterId: string): string {
  if (resolveOwner(source, emitterId).kind !== "emitter") {
    throw new AgentError(
      "invalid_argument",
      `"${emitterId}" is a mesh; only emitters have events.`,
    );
  }
  return emitterId;
}

/**
 * An event's `time` argument. An object there is the whole event passed as one argument - refused
 * with the positional `signature` spelled out, rather than as a puzzling "time must be a number".
 */
function requireEventTime(signature: string, time: unknown): number {
  if (isRecord(time)) {
    throw new AgentError(
      "invalid_argument",
      `${signature} takes positional arguments, not an object.`,
    );
  }
  return requireFiniteNumber("time", time);
}

function requireEvent(source: SourceState, emitterId: string, eventId: string): TimelineEvent {
  const emitter = source.scene.emitters.find((candidate) => candidate.id === emitterId);
  const event = emitter?.events.find((candidate) => candidate.id === eventId);
  if (event === undefined) {
    throw new AgentError("not_found", `Emitter "${emitterId}" has no event "${eventId}".`);
  }
  return event;
}

/** The fields a patch may set on each event kind; the command ignores the others silently. */
const EVENT_FIELDS: Readonly<Record<TimelineEvent["kind"], readonly string[]>> = {
  burst: ["time", "count"],
  play: ["time", "rate", "duration"],
};

function requirePatch(event: TimelineEvent, patch: EventPatch): EventPatch {
  for (const [key, value] of Object.entries(patch)) {
    if (!EVENT_FIELDS[event.kind].includes(key)) {
      throw new AgentError(
        "invalid_argument",
        `A ${event.kind} event has no field "${key}" (fields: ${EVENT_FIELDS[event.kind].join(", ")}).`,
      );
    }
    requireFiniteNumber(key, value);
  }
  return patch;
}

function requireReaction(
  source: SourceState,
  emitterId: string,
  reactionId: string,
): DeathReaction {
  const emitter = source.scene.emitters.find((candidate) => candidate.id === emitterId);
  const reaction = emitter?.reactions.find((candidate) => candidate.id === reactionId);
  if (reaction === undefined) {
    throw new AgentError("not_found", `Emitter "${emitterId}" has no reaction "${reactionId}".`);
  }
  return reaction;
}

/** `sourceId` as an emitter of `source` - whether it may be reacted to is `canReact`'s call. */
function requireSourceEmitter(source: SourceState, sourceId: unknown): string {
  if (typeof sourceId !== "string") {
    throw new AgentError("invalid_argument", "sourceId must be an emitter id.");
  }
  return requireEmitter(source, sourceId);
}

/** Why `emitterId` may not react to an existing `sourceId` (see `canReact`). */
function cycleError(emitterId: string, sourceId: string): AgentError {
  return new AgentError(
    "invalid_argument",
    `"${emitterId}" cannot react to "${sourceId}": reactions may not form a cycle ` +
      "(an emitter reacting to itself included).",
  );
}

/** Adds the reaction, or explains why the command refused it. */
function requireAdded(id: string | undefined, emitterId: string, sourceId: string): string {
  if (id === undefined) {
    throw cycleError(emitterId, sourceId);
  }
  return id;
}

function requirePositiveDuration(duration: unknown): number {
  const value = requireFiniteNumber("duration", duration);
  if (value <= 0) {
    throw new AgentError("invalid_argument", "A reaction's play needs a duration above 0.");
  }
  return value;
}

/** The fields a patch may set on each reaction kind. */
const REACTION_FIELDS: Readonly<Record<DeathReaction["kind"], readonly string[]>> = {
  burst: ["source", "count"],
  play: ["source", "rate", "duration"],
};

function requireReactionPatch(
  source: SourceState,
  emitterId: string,
  reaction: DeathReaction,
  patch: ReactionPatch,
): ReactionPatch {
  for (const [key, value] of Object.entries(patch)) {
    if (!REACTION_FIELDS[reaction.kind].includes(key)) {
      throw new AgentError(
        "invalid_argument",
        `A ${reaction.kind} reaction has no field "${key}" (fields: ${REACTION_FIELDS[reaction.kind].join(", ")}).`,
      );
    }
    if (key === "source") {
      const sourceId = requireSourceEmitter(source, value);
      if (!canReact(source.scene.emitters, emitterId, sourceId, reaction.id)) {
        throw cycleError(emitterId, sourceId);
      }
    } else if (key === "duration") {
      requirePositiveDuration(value);
    } else {
      requireFiniteNumber(key, value);
    }
  }
  return patch;
}

export function createTimelineEdits(session: EditSession): TimelineEdits {
  return {
    ...createKeyframeEdits(session),

    setDuration: (seconds) =>
      session.mutate((store) =>
        setTimelineDuration(store, requireFiniteNumber("seconds", seconds)),
      ),

    setFps: (fps) =>
      session.mutate((store) => setTimelineFps(store, requireFiniteNumber("fps", fps))),

    setLoop: (loop) =>
      session.mutate((store) => setTimelineLoop(store, requireBoolean("loop", loop))),

    addBurst: (emitterId, time, count) =>
      session.mutate((store) =>
        addBurstEvent(
          store,
          requireEmitter(store.getSource(), emitterId),
          requireEventTime("addBurst(emitterId, time, count)", time),
          requireFiniteNumber("count", count),
        ),
      ),

    addPlay: (emitterId, time, rate, duration) =>
      session.mutate((store) =>
        addPlayEvent(
          store,
          requireEmitter(store.getSource(), emitterId),
          requireEventTime("addPlay(emitterId, time, rate, duration)", time),
          requireFiniteNumber("rate", rate),
          requireFiniteNumber("duration", duration),
        ),
      ),

    updateEvent: (emitterId, eventId, patch) =>
      session.mutate((store) => {
        const event = requireEvent(
          store.getSource(),
          requireEmitter(store.getSource(), emitterId),
          eventId,
        );
        updateEvent(store, emitterId, eventId, requirePatch(event, patch));
      }),

    removeEvent: (emitterId, eventId) =>
      session.mutate((store) => {
        requireEvent(store.getSource(), requireEmitter(store.getSource(), emitterId), eventId);
        removeEvent(store, emitterId, eventId);
      }),

    setEventsExcluded: (emitterId, excluded) =>
      session.mutate((store) =>
        setLiveEvents(
          store,
          requireEmitter(store.getSource(), emitterId),
          requireBoolean("excluded", excluded),
        ),
      ),

    addBurstOnDeath: (emitterId, sourceId, count) =>
      session.mutate((store) => {
        const source = store.getSource();
        const target = requireEmitter(source, emitterId);
        const from = requireSourceEmitter(source, sourceId);
        const action = { kind: "burst" as const, count: requireFiniteNumber("count", count) };
        return requireAdded(addReaction(store, target, from, action), target, from);
      }),

    addPlayOnDeath: (emitterId, sourceId, rate, duration) =>
      session.mutate((store) => {
        const source = store.getSource();
        const target = requireEmitter(source, emitterId);
        const from = requireSourceEmitter(source, sourceId);
        const action = {
          kind: "play" as const,
          rate: requireFiniteNumber("rate", rate),
          duration: requirePositiveDuration(duration),
        };
        return requireAdded(addReaction(store, target, from, action), target, from);
      }),

    updateReaction: (emitterId, reactionId, patch) =>
      session.mutate((store) => {
        const source = store.getSource();
        const target = requireEmitter(source, emitterId);
        const reaction = requireReaction(source, target, reactionId);
        updateReaction(
          store,
          target,
          reactionId,
          requireReactionPatch(source, target, reaction, patch),
        );
      }),

    removeReaction: (emitterId, reactionId) =>
      session.mutate((store) => {
        requireReaction(
          store.getSource(),
          requireEmitter(store.getSource(), emitterId),
          reactionId,
        );
        removeReaction(store, emitterId, reactionId);
      }),
  };
}
