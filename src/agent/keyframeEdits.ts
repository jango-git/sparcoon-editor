/**
 * Keyframe agent edits, part of the `timeline` namespace: keys on an entity's transform channels
 * and on an owner's Timeline Values (the named graph inputs a `timeline-value` node declares), and
 * which of either the export leaves to the host code. A thin layer over the timeline panel's own
 * commands, so times snap to the frame grid and a key set on an occupied frame replaces it, as in
 * the editor. Rotation travels as Euler degrees, as everywhere in this API; the key itself stores
 * a quaternion and interpolates along the shortest arc, so a turn past 180 degrees between two
 * keys needs a key in between.
 */

import { isKeyframeValue, type EditorGraph } from "../domain/graphModel";
import { timelineValueDeclarations } from "../domain/nodePalette";
import {
  type ChannelValue,
  moveTrackKeyframes,
  moveTransformKeyframes,
  removeKeyframe,
  removeTransformKeyframe,
  setKeyframe,
  setKeyframeValue,
  setLiveChannel,
  setLiveParam,
  setTransformKeyframe,
  setTransformKeyframeValue,
} from "../model/commands";
import type { AnimationTrack, SourceState } from "../model/editorState";
import type { SceneEntity } from "../model/entity";
import {
  eulerToQuat,
  TRANSFORM_CHANNELS,
  type TransformChannel,
  type TransformTrack,
} from "../model/transform";
import { requireFiniteNumber, requireVector, requireVector3 } from "./arguments.Internal";
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
   * degrees for `"rotation"`. Returns the key id.
   */
  setTransformKey(
    entityId: string,
    channel: TransformChannel,
    time: number,
    value: readonly number[],
  ): string;
  /** Keys Timeline Value `name` of an emitter or mesh at `time`. Returns the key id. */
  setValueKey(
    ownerId: string,
    name: string,
    time: number,
    value: number | readonly number[],
  ): string;
  /** Changes a key's value, keeping its time; the value has the shape the key already holds. */
  setKeyValue(entityId: string, keyId: string, value: number | readonly number[]): void;
  /** Retimes keys of one entity, transform and value keys alike, in one step. */
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

    setTransformKey: (entityId, channel, time, value) =>
      session.mutate((store) => {
        const { entity } = entityKeys(store.getSource(), entityId);
        const checked = requireChannel(channel);
        return setTransformKeyframe(
          store,
          entity,
          checked,
          requireFiniteNumber("time", time),
          channelValue(checked, value),
        );
      }),

    setValueKey: (ownerId, name, time, value) =>
      session.mutate((store) => {
        const keys = ownerKeys(store.getSource(), ownerId);
        const declared = requireDeclared(keys, name);
        return setKeyframe(
          store,
          keys.entity,
          name,
          requireFiniteNumber("time", time),
          requireValue("value", value, componentsOf(declared.type)),
        );
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
        setLiveChannel(store, entity, requireChannel(channel), requireBoolean(excluded));
      }),

    setValueExcluded: (ownerId, name, excluded) =>
      session.mutate((store) => {
        const keys = ownerKeys(store.getSource(), ownerId);
        requireDeclared(keys, name);
        setLiveParam(store, keys.entity, name, requireBoolean(excluded));
      }),
  };
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new AgentError("invalid_argument", "excluded must be a boolean.");
  }
  return value;
}
