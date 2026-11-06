/**
 * Timeline agent edits: the scene-wide length and frame rate, each emitter's spawn events, and
 * (from {@link KeyframeEdits}) keyframes. An emitter spawns nothing until an event fires, so these
 * are what make a capture show particles. Times and durations snap to the frame grid, as they do
 * in the editor.
 */

import {
  addBurstEvent,
  addPlayEvent,
  removeEvent,
  setTimelineDuration,
  setTimelineFps,
  updateEvent,
} from "../model/commands";
import type { SourceState, TimelineEvent } from "../model/editorState";
import { requireFiniteNumber } from "./arguments.Internal";
import { resolveOwner } from "./address.Internal";
import { AgentError } from "./errors";
import { createKeyframeEdits, type KeyframeEdits } from "./keyframeEdits";
import type { EditSession } from "./transaction.Internal";

export interface EventPatch {
  readonly time?: number;
  /** Burst events only. */
  readonly count?: number;
  /** Play events only. */
  readonly rate?: number;
  /** Play events only; 0 plays forever. */
  readonly duration?: number;
}

export interface TimelineEdits extends KeyframeEdits {
  setDuration(seconds: number): void;
  setFps(fps: number): void;
  /** Spawns `count` particles at once at `time`. Returns the event id. */
  addBurst(emitterId: string, time: number, count: number): string;
  /** Emits `rate` particles per second from `time` for `duration` seconds (0 = forever). */
  addPlay(emitterId: string, time: number, rate: number, duration: number): string;
  updateEvent(emitterId: string, eventId: string, patch: EventPatch): void;
  removeEvent(emitterId: string, eventId: string): void;
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

export function createTimelineEdits(session: EditSession): TimelineEdits {
  return {
    ...createKeyframeEdits(session),

    setDuration: (seconds) =>
      session.mutate((store) =>
        setTimelineDuration(store, requireFiniteNumber("seconds", seconds)),
      ),

    setFps: (fps) =>
      session.mutate((store) => setTimelineFps(store, requireFiniteNumber("fps", fps))),

    addBurst: (emitterId, time, count) =>
      session.mutate((store) =>
        addBurstEvent(
          store,
          requireEmitter(store.getSource(), emitterId),
          requireFiniteNumber("time", time),
          requireFiniteNumber("count", count),
        ),
      ),

    addPlay: (emitterId, time, rate, duration) =>
      session.mutate((store) =>
        addPlayEvent(
          store,
          requireEmitter(store.getSource(), emitterId),
          requireFiniteNumber("time", time),
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
  };
}
