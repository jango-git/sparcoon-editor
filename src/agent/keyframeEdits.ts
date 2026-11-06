/**
 * Keyframe agent edits, part of the `timeline` namespace: keys on an entity's transform channels
 * and on an owner's Timeline Values (the named graph inputs a `timeline-value` node declares), and
 * which of either the export leaves to the host code. A thin layer over the timeline panel's own
 * commands, so times snap to the frame grid and a key set on an occupied frame replaces it, as in
 * the editor. Rotation travels as Euler degrees, as everywhere in this API; the key itself stores
 * a quaternion and interpolates along the shortest arc, so a turn past 180 degrees between two
 * keys needs a key in between.
 */

import type { FXKeyEase } from "sparcoon";
import { asKeyEase, FX_KEY_EASES } from "sparcoon/editor";
import { isKeyframeValue, type EditorGraph } from "../domain/graphModel";
import { timelineValueDeclarations } from "../domain/nodePalette";
import {
  type ChannelValue,
  moveTrackKeyframes,
  moveTransformKeyframes,
  removeKeyframe,
  removeTransformKeyframe,
  setKeyframe,
  setKeyframeEase,
  setKeyframeValue,
  setLiveChannel,
  setLiveParam,
  setTransformKeyframe,
  setTransformKeyframeEase,
  setTransformKeyframeValue,
} from "../model/commands";
import type { AnimationTrack, Keyframe, SourceState } from "../model/editorState";
import { KEY_EPSILON, snapTime } from "../model/keyframeTrackOps";
import type { SceneEntity } from "../model/entity";
import {
  eulerToQuat,
  TRANSFORM_CHANNELS,
  type TransformChannel,
  type TransformTrack,
} from "../model/transform";
import {
  requireBoolean,
  requireFiniteNumber,
  requireKnownKeys,
  requireVector,
  requireVector3,
} from "./arguments.Internal";
import { isRecord } from "../util/guards";
import { resolveEntity } from "./address.Internal";
import { AgentError } from "./errors";
import type { EditSession } from "./transaction.Internal";

/** A Timeline Value as its declaring node states it. */
export interface TimelineValueView {
  readonly name: string;
  /** `"color"` is a vec4 edited with a color picker. */
  readonly type: "float" | "vec2" | "vec3" | "vec4" | "color";
  /** The node's inline value: what the export uses for a value with no keys. */
  readonly value: number | readonly number[];
}

/** How a key is set. */
export interface SetKeyOptions {
  /**
   * Replace a key already on that frame. Without it an occupied frame is refused: keys snap to
   * the frame grid, so two keys closer together than a frame would otherwise silently become one.
   */
  readonly replace?: boolean;
  /**
   * The curve from this key to the next. When omitted, a replaced key's curve is kept; a new key
   * is linear.
   */
  readonly ease?: FXKeyEase;
}

/** A retime of one key, transform or Timeline Value alike. */
export interface KeyMove {
  readonly id: string;
  readonly time: number;
}

export interface KeyframeEdits {
  /** The Timeline Values `ownerId`'s graphs declare, in graph order. */
  values(ownerId: string): readonly TimelineValueView[];
  /**
   * Keys `channel` of an entity (the VFX group included) at `time` to `value` - a vec3, Euler
   * degrees for `"rotation"`. Returns the key id. See {@link SetKeyOptions} for a taken frame.
   */
  setTransformKey(
    entityId: string,
    channel: TransformChannel,
    time: number,
    value: readonly number[],
    options?: SetKeyOptions,
  ): string;
  /** Keys Timeline Value `name` of an emitter or mesh at `time`. Returns the key id. */
  setValueKey(
    ownerId: string,
    name: string,
    time: number,
    value: number | readonly number[],
    options?: SetKeyOptions,
  ): string;
  /** Changes the curve from a key to the next one. */
  setKeyEase(entityId: string, keyId: string, ease: FXKeyEase): void;
  /** Changes a key's value, keeping its time; the value has the shape the key already holds. */
  setKeyValue(entityId: string, keyId: string, value: number | readonly number[]): void;
  /**
   * Retimes keys of one entity, transform and value keys alike, in one step. Refused, all of it,
   * when two keys of one track would end up on the same frame.
   */
  moveKeys(entityId: string, moves: readonly KeyMove[]): void;
  /** Removes a key; a track left with no keys goes with it. */
  removeKey(entityId: string, keyId: string): void;
  /**
   * Leaves `channel` out of the export (`excluded: true`), so the host code drives it, or gives it
   * back to the timeline. The VFX group's channels are always the host's.
   */
  setChannelExcluded(entityId: string, channel: TransformChannel, excluded: boolean): void;
  /** The same for Timeline Value `name` of an emitter or mesh. */
  setValueExcluded(ownerId: string, name: string, excluded: boolean): void;
}

/** What the keyframe edits read off one entity's document. */
interface EntityKeys {
  readonly entity: SceneEntity;
  readonly transformTracks: readonly TransformTrack[];
  /** Timeline Value tracks; `undefined` for the VFX group, which has none. */
  readonly tracks: readonly AnimationTrack[] | undefined;
  readonly graphs: readonly EditorGraph[];
}

function entityKeys(source: SourceState, entityId: string): EntityKeys {
  const entity = resolveEntity(source, entityId);
  const { scene } = source;
  if (entity.kind === "vfx") {
    return { entity, transformTracks: scene.vfx.transformTracks, tracks: undefined, graphs: [] };
  }
  if (entity.kind === "emitter") {
    const emitter = scene.emitters.find((candidate) => candidate.id === entity.id);
    if (emitter !== undefined) {
      return {
        entity,
        transformTracks: emitter.transformTracks,
        tracks: emitter.tracks,
        graphs: [emitter.renderGraph, emitter.behaviorGraph],
      };
    }
  } else {
    const mesh = scene.meshes.find((candidate) => candidate.id === entity.id);
    if (mesh !== undefined) {
      return {
        entity,
        transformTracks: mesh.transformTracks,
        tracks: mesh.tracks,
        graphs: [mesh.renderGraph],
      };
    }
  }
  throw new AgentError("not_found", `No entity with id "${entityId}".`);
}

/** An emitter's or mesh's keys; the VFX group has no Timeline Values. */
function ownerKeys(
  source: SourceState,
  ownerId: string,
): EntityKeys & { tracks: readonly AnimationTrack[] } {
  const keys = entityKeys(source, ownerId);
  if (keys.tracks === undefined) {
    throw new AgentError("invalid_argument", "The VFX group has no Timeline Values.");
  }
  return { ...keys, tracks: keys.tracks };
}

function timelineValues(graphs: readonly EditorGraph[]): readonly TimelineValueView[] {
  return [...timelineValueDeclarations(graphs)].map(([name, node]) => {
    const { type, value } = node.parameters;
    return {
      name,
      // Unset on a node still at its defaults: a float of 0.
      type: isValueType(type) ? type : "float",
      value: isKeyframeValue(value) ? structuredClone(value) : 0,
    };
  });
}

const VALUE_TYPES: readonly TimelineValueView["type"][] = [
  "float",
  "vec2",
  "vec3",
  "vec4",
  "color",
];

function isValueType(value: unknown): value is TimelineValueView["type"] {
  return VALUE_TYPES.includes(value as TimelineValueView["type"]);
}

/** Components a value of `type` has: 1 for a float, else the vector's width (a color is a vec4). */
function componentsOf(type: TimelineValueView["type"]): number {
  return type === "float" ? 1 : type === "color" ? 4 : Number(type.slice(3));
}

/** A key value of `components` components: a number for 1, an array of them otherwise. */
function requireValue(
  name: string,
  value: unknown,
  components: number,
): number | readonly number[] {
  return components === 1
    ? requireFiniteNumber(name, value)
    : requireVector(name, value, components);
}

function requireEase(ease: unknown): FXKeyEase {
  const known = asKeyEase(ease);
  if (known === undefined) {
    throw new AgentError("invalid_argument", `ease must be one of ${FX_KEY_EASES.join(", ")}.`);
  }
  return known;
}

/** {@link SetKeyOptions} checked: a plain object of known keys, each of its type. */
function requireSetKeyOptions(options: unknown): {
  readonly replace: boolean;
  readonly ease: FXKeyEase | undefined;
} {
  if (!isRecord(options)) {
    throw new AgentError("invalid_argument", "options must be an object.");
  }
  requireKnownKeys("options", options, ["replace", "ease"]);
  if (options["replace"] !== undefined && typeof options["replace"] !== "boolean") {
    throw new AgentError("invalid_argument", "options.replace must be a boolean.");
  }
  return {
    replace: options["replace"] === true,
    ease: options["ease"] === undefined ? undefined : requireEase(options["ease"]),
  };
}

function requireChannel(channel: unknown): TransformChannel {
  if (!TRANSFORM_CHANNELS.includes(channel as TransformChannel)) {
    throw new AgentError(
      "invalid_argument",
      `channel must be one of ${TRANSFORM_CHANNELS.join(", ")}.`,
    );
  }
  return channel as TransformChannel;
}

/** A transform key value as stored: the vec3 itself, or a quaternion from Euler degrees. */
function channelValue(channel: TransformChannel, value: unknown): ChannelValue {
  const vector = requireVector3("value", value);
  return channel === "rotation" ? eulerToQuat(vector) : vector;
}

/** Timeline Value `name` as its owner's graphs declare it; undeclared is `not_found`. */
function requireDeclared(keys: EntityKeys, name: string): TimelineValueView {
  const declared = timelineValues(keys.graphs).find((value) => value.name === name);
  if (declared === undefined) {
    throw new AgentError("not_found", `No Timeline Value "${name}" in this owner's graphs.`);
  }
  return declared;
}

/** The frame `time` snaps to, as a sentence's worth of text. */
function frameText(source: SourceState, time: number): string {
  return `the frame at ${String(snapTime(source, time))}s (keys snap to the ${String(source.timeline.fps)} fps grid)`;
}

/** Refuses a key on a frame `keys` already holds, unless asked to `replace` it. */
function requireFreeFrame(
  source: SourceState,
  keys: readonly Keyframe[],
  time: number,
  track: string,
  replace: boolean,
): void {
  const frameTime = snapTime(source, time);
  const taken = keys.find((key) => Math.abs(key.time - frameTime) <= KEY_EPSILON);
  if (taken !== undefined && !replace) {
    throw new AgentError(
      "rejected",
      `${track} already has key "${taken.id}" on ${frameText(source, time)}; pass ` +
        "{ replace: true } to replace it, or raise the frame rate with timeline.setFps.",
    );
  }
}

/** Refuses `moves` when they would leave two keys of one of `tracks` on the same frame. */
function requireDistinctFrames(
  source: SourceState,
  tracks: readonly { readonly label: string; readonly keys: readonly Keyframe[] }[],
  moves: readonly KeyMove[],
): void {
  const times = new Map(moves.map((move) => [move.id, snapTime(source, move.time)]));
  for (const track of tracks) {
    const placed: Keyframe[] = [];
    for (const key of track.keys) {
      const time = times.get(key.id) ?? key.time;
      const clash = placed.find((other) => Math.abs(other.time - time) <= KEY_EPSILON);
      if (clash !== undefined) {
        throw new AgentError(
          "rejected",
          `Keys "${clash.id}" and "${key.id}" of ${track.label} would share ${frameText(source, time)}.`,
        );
      }
      placed.push({ ...key, time });
    }
  }
}

/** Where key `keyId` lives on an entity: a transform channel, or a Timeline Value track. */
type KeyLocation =
  | { readonly kind: "transform"; readonly channel: TransformChannel }
  | { readonly kind: "value"; readonly value: number | readonly number[] };

function locateKey(keys: EntityKeys, keyId: string): KeyLocation {
  for (const track of keys.transformTracks) {
    if (track.keys.some((key) => key.id === keyId)) {
      return { kind: "transform", channel: track.channel };
    }
  }
  for (const track of keys.tracks ?? []) {
    const key = track.keys.find((candidate) => candidate.id === keyId);
    if (key !== undefined) {
      return { kind: "value", value: key.value };
    }
  }
  throw new AgentError("not_found", `This entity has no key "${keyId}".`);
}

export function createKeyframeEdits(session: EditSession): KeyframeEdits {
  return {
    values: (ownerId) => timelineValues(ownerKeys(session.source(), ownerId).graphs),

    setTransformKey: (entityId, channel, time, value, options = {}) =>
      session.mutate((store) => {
        const source = store.getSource();
        const { entity, transformTracks } = entityKeys(source, entityId);
        const checked = requireChannel(channel);
        const keyTime = requireFiniteNumber("time", time);
        const keyValue = channelValue(checked, value);
        const { replace, ease } = requireSetKeyOptions(options);
        requireFreeFrame(
          source,
          transformTracks.find((track) => track.channel === checked)?.keys ?? [],
          keyTime,
          `The ${checked} channel`,
          replace,
        );
        const id = setTransformKeyframe(store, entity, checked, keyTime, keyValue);
        if (ease !== undefined) {
          setTransformKeyframeEase(store, entity, id, ease);
        }
        return id;
      }),

    setValueKey: (ownerId, name, time, value, options = {}) =>
      session.mutate((store) => {
        const source = store.getSource();
        const keys = ownerKeys(source, ownerId);
        const declared = requireDeclared(keys, name);
        const keyTime = requireFiniteNumber("time", time);
        const keyValue = requireValue("value", value, componentsOf(declared.type));
        const { replace, ease } = requireSetKeyOptions(options);
        requireFreeFrame(
          source,
          keys.tracks.find((track) => track.name === name)?.keys ?? [],
          keyTime,
          `Timeline Value "${name}"`,
          replace,
        );
        const id = setKeyframe(store, keys.entity, name, keyTime, keyValue);
        if (ease !== undefined) {
          setKeyframeEase(store, keys.entity, id, ease);
        }
        return id;
      }),

    setKeyEase: (entityId, keyId, ease) =>
      session.mutate((store) => {
        const keys = entityKeys(store.getSource(), entityId);
        const checked = requireEase(ease);
        if (locateKey(keys, keyId).kind === "transform") {
          setTransformKeyframeEase(store, keys.entity, keyId, checked);
        } else {
          setKeyframeEase(store, keys.entity, keyId, checked);
        }
      }),

    setKeyValue: (entityId, keyId, value) =>
      session.mutate((store) => {
        const keys = entityKeys(store.getSource(), entityId);
        const location = locateKey(keys, keyId);
        if (location.kind === "transform") {
          setTransformKeyframeValue(
            store,
            keys.entity,
            keyId,
            channelValue(location.channel, value),
          );
          return;
        }
        const components = typeof location.value === "number" ? 1 : location.value.length;
        setKeyframeValue(store, keys.entity, keyId, requireValue("value", value, components));
      }),

    moveKeys: (entityId, moves) =>
      session.mutate((store) => {
        const keys = entityKeys(store.getSource(), entityId);
        if (!Array.isArray(moves)) {
          throw new AgentError("invalid_argument", "moves must be an array of { id, time }.");
        }
        const transformMoves: KeyMove[] = [];
        const valueMoves: KeyMove[] = [];
        moves.forEach((move, index) => {
          const checked = {
            id: move.id,
            time: requireFiniteNumber(`moves[${String(index)}].time`, move.time),
          };
          (locateKey(keys, move.id).kind === "transform" ? transformMoves : valueMoves).push(
            checked,
          );
        });
        requireDistinctFrames(
          store.getSource(),
          [
            ...keys.transformTracks.map((track) => ({
              label: `the ${track.channel} channel`,
              keys: track.keys,
            })),
            ...(keys.tracks ?? []).map((track) => ({
              label: `Timeline Value "${track.name}"`,
              keys: track.keys,
            })),
          ],
          [...transformMoves, ...valueMoves],
        );
        moveTransformKeyframes(store, keys.entity, transformMoves);
        moveTrackKeyframes(store, keys.entity, valueMoves);
      }),

    removeKey: (entityId, keyId) =>
      session.mutate((store) => {
        const keys = entityKeys(store.getSource(), entityId);
        if (locateKey(keys, keyId).kind === "transform") {
          removeTransformKeyframe(store, keys.entity, keyId);
        } else {
          removeKeyframe(store, keys.entity, keyId);
        }
      }),

    setChannelExcluded: (entityId, channel, excluded) =>
      session.mutate((store) => {
        const { entity } = entityKeys(store.getSource(), entityId);
        if (entity.kind === "vfx") {
          throw new AgentError(
            "invalid_argument",
            "The VFX group's channels are always left to the host code.",
          );
        }
        setLiveChannel(
          store,
          entity,
          requireChannel(channel),
          requireBoolean("excluded", excluded),
        );
      }),

    setValueExcluded: (ownerId, name, excluded) =>
      session.mutate((store) => {
        const keys = ownerKeys(store.getSource(), ownerId);
        requireDeclared(keys, name);
        setLiveParam(store, keys.entity, name, requireBoolean("excluded", excluded));
      }),
  };
}
