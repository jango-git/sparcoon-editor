/**
 * Turns whatever `loadSource()` returns (a valid document, or corrupt/absent storage) into a valid
 * {@link EditorState}, defaulting every missing or malformed field so a garbled localStorage entry
 * can never crash startup - it falls back to a fresh document instead.
 */

import { createEmptyGraph, type EditorGraph } from "../domain/graphModel";
import { GraphKind, PARTICLE_ONLY_SURFACE_SLOTS } from "../domain/nodePalette";
import { ensureSinks } from "../domain/sinks";
import {
  seedIdentifierCounterFromRawSource,
  seedIdentifierCounterFromSource,
} from "../model/commands/documentIdentifiers";
import { nextIdentifier } from "../model/commands/identifier";
import {
  createDefaultVfx,
  createInitialState,
  DEFAULT_EMITTER_SETTINGS,
  DEFAULT_TIMELINE,
  type AnimationTrack,
  type EditorState,
  type EmitterDoc,
  type EmitterSettings,
  type EnvironmentAsset,
  type MeshAsset,
  type SourceState,
  type TextureAsset,
  type TimelineEvent,
  type TimelineState,
  type VfxDoc,
  type VfxMeshDoc,
} from "../model/editorState";
import {
  IDENTITY_TRANSFORM,
  TRANSFORM_CHANNELS,
  type Quat,
  type Transform,
  type TransformChannel,
  type TransformTrack,
  type Vec3,
} from "../model/transform";
import { asFiniteNumber, isFiniteNumber, isRecord } from "../util/guards";
import { getEnvironmentBlob, putEnvironmentBlob } from "./environmentBlobStore";
import { loadSource } from "./localStore";

export async function loadInitialState(): Promise<EditorState> {
  const source = (await restoreSource()) ?? createInitialState().source;
  seedIdentifierCounterFromSource(source);
  return { source, derived: {} };
}

/** The persisted document, defended down to a valid source, or `undefined` to start fresh. */
async function restoreSource(): Promise<SourceState | undefined> {
  try {
    const raw = loadSource();
    // Seed from the raw document *before* normalizing: normalization can itself backfill a missing
    // id (see seedIdentifierCounterFromRawSource's doc), so seeding only afterward is too late.
    seedIdentifierCounterFromRawSource(raw);
    const normalized = normalizeSource(raw);
    return normalized === undefined ? undefined : await hydrateEnvironments(normalized);
  } catch (error) {
    // Belt-and-suspenders: normalize defaults every field, but an unforeseen shape must still
    // start fresh rather than brick the editor.
    console.warn("Discarding an unreadable saved document; starting fresh", error);
    return undefined;
  }
}

/**
 * Refills each HDRI's `dataUrl` (stripped from localStorage - see `localStore.ts`) from IndexedDB.
 * A document saved before HDRI bytes moved to IndexedDB still carries its full `dataUrl` here
 * (normalizeEnvironments read it straight off the old localStorage entry); that legacy value is
 * migrated into IndexedDB now; so it survives the next save's strip instead of being silently lost.
 * A blob missing from both (storage cleared) leaves the asset's `dataUrl` empty; the environment
 * registry just fails its decode.
 */
async function hydrateEnvironments(source: SourceState): Promise<SourceState> {
  if (source.environments.length === 0) {
    return source;
  }
  const environments = await Promise.all(
    source.environments.map(async (asset) => {
      if (asset.dataUrl !== "") {
        void putEnvironmentBlob(asset.name, asset.dataUrl);
        return asset;
      }
      const dataUrl = await getEnvironmentBlob(asset.name);
      return dataUrl === undefined ? asset : { ...asset, dataUrl };
    }),
  );
  return { ...source, environments };
}

/** Guarantees a persisted graph's structural containers so a missing/non-object field can't crash
 *  {@link ensureSinks}. Node/connection *contents* are trusted as-is - a bad one is a graph error. */
function normalizeGraph(raw: unknown, kind: GraphKind): EditorGraph {
  const empty = createEmptyGraph();
  const record = isRecord(raw) ? raw : {};
  const graph: EditorGraph = {
    nodes: isRecord(record["nodes"]) ? (record["nodes"] as EditorGraph["nodes"]) : empty.nodes,
    connections: Array.isArray(record["connections"])
      ? (record["connections"] as EditorGraph["connections"])
      : empty.connections,
    outputBindings: Array.isArray(record["outputBindings"])
      ? (record["outputBindings"] as EditorGraph["outputBindings"])
      : empty.outputBindings,
    attributes: Array.isArray(record["attributes"])
      ? (record["attributes"] as EditorGraph["attributes"])
      : empty.attributes,
    comments: Array.isArray(record["comments"])
      ? (record["comments"] as EditorGraph["comments"])
      : empty.comments,
  };
  return ensureSinks(graph, kind);
}

/** Normalizes a persisted document to the current source shape; anything unrecognized (not a
 *  scene, or a scene with no valid emitter) returns `undefined`, so the caller starts fresh. */
export function normalizeSource(raw: unknown): SourceState | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const scene = raw["scene"];
  if (!isRecord(scene)) {
    return undefined;
  }
  const rawEmitters = Array.isArray(scene["emitters"]) ? scene["emitters"] : [];
  const emitters = rawEmitters
    .map(normalizeEmitter)
    .filter((emitter): emitter is EmitterDoc => emitter !== undefined);
  const first = emitters[0];
  if (first === undefined) {
    return undefined;
  }
  const active = emitters.find((emitter) => emitter.id === scene["activeEmitterId"]);
  const meshes = normalizeMeshes(scene["meshes"]);
  const activeMesh = meshes.find((mesh) => mesh.id === scene["activeMeshId"]);
  const activeMeshId = activeMesh?.id ?? meshes[0]?.id;
  // The graph editor targets a mesh only when it was persisted as such AND a mesh survives; a
  // dangling "vfxMesh" (all meshes dropped) falls back to the active emitter.
  const activeGraphKind =
    scene["activeGraphKind"] === "vfxMesh" && activeMeshId !== undefined ? "vfxMesh" : "emitter";
  return {
    name: typeof raw["name"] === "string" ? raw["name"] : "",
    scene: {
      vfx: normalizeVfx(scene["vfx"]),
      emitters,
      activeEmitterId: active?.id ?? first.id,
      meshes,
      // A scene may hold zero meshes, so `activeMeshId` stays undefined when none survive; otherwise
      // it falls to the first surviving mesh if the persisted active id has gone stale.
      activeMeshId,
      activeGraphKind,
    },
    assets: normalizeAssets(raw["assets"]),
    environments: normalizeEnvironments(raw["environments"]),
    meshAssets: normalizeMeshAssets(raw["meshAssets"]),
    timeline: normalizeTimeline(raw["timeline"]),
  };
}

/** Keeps only well-formed persisted VFX meshes (a mesh missing its id is dropped, not fatal). */
function normalizeMeshes(raw: unknown): readonly VfxMeshDoc[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map(normalizeVfxMesh).filter((mesh): mesh is VfxMeshDoc => mesh !== undefined);
}

/** Drops mesh render-graph bindings to a particle-only surface slot (e.g. `particleTransform`): a
 *  mesh has no such target output, so a stale binding would fail to compile. */
function pruneParticleOnlyBindings(graph: EditorGraph): EditorGraph {
  const kept = graph.outputBindings.filter(
    (binding) => !PARTICLE_ONLY_SURFACE_SLOTS.has(binding.slot),
  );
  return kept.length === graph.outputBindings.length ? graph : { ...graph, outputBindings: kept };
}

function normalizeVfxMesh(value: unknown): VfxMeshDoc | undefined {
  if (!isRecord(value) || typeof value["id"] !== "string") {
    return undefined;
  }
  const name = value["name"];
  return {
    id: value["id"],
    name: typeof name === "string" && name.trim() !== "" ? name : "Mesh",
    renderGraph: pruneParticleOnlyBindings(normalizeGraph(value["renderGraph"], GraphKind.Render)),
    tracks: normalizeTracks(value["tracks"]),
    transform: normalizeTransform(value["transform"]),
    transformTracks: normalizeTransformTracks(value["transformTracks"]),
    liveChannels: normalizeLiveChannels(value["liveChannels"]),
    liveParams: normalizeLiveParams(value["liveParams"]),
    // Omitted (not `false`) when not hidden, so a document saved before mute existed round-trips
    // byte-for-byte and `exactOptionalPropertyTypes` never sees an explicit `undefined` assignment.
    ...(value["hidden"] === true ? { hidden: true } : {}),
  };
}

/** Keeps only well-formed persisted assets (a corrupt entry is dropped, not fatal). */
function normalizeAssets(raw: unknown): readonly TextureAsset[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const assets: TextureAsset[] = [];
  for (const value of raw) {
    if (
      isRecord(value) &&
      typeof value["name"] === "string" &&
      typeof value["dataUrl"] === "string" &&
      typeof value["width"] === "number" &&
      typeof value["height"] === "number"
    ) {
      assets.push({
        name: value["name"],
        label: typeof value["label"] === "string" ? value["label"] : value["name"],
        dataUrl: value["dataUrl"],
        width: value["width"],
        height: value["height"],
      });
    }
  }
  return assets;
}

/** Keeps only well-formed persisted HDRI library entries (name + dataUrl + byteSize). */
function normalizeEnvironments(raw: unknown): readonly EnvironmentAsset[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const assets: EnvironmentAsset[] = [];
  for (const value of raw) {
    if (
      isRecord(value) &&
      typeof value["name"] === "string" &&
      typeof value["dataUrl"] === "string" &&
      typeof value["byteSize"] === "number"
    ) {
      assets.push({
        name: value["name"],
        label: typeof value["label"] === "string" ? value["label"] : value["name"],
        dataUrl: value["dataUrl"],
        byteSize: value["byteSize"],
      });
    }
  }
  return assets;
}

/** `readonly number[]`, dropping any non-finite element - a corrupt/truncated entry degrades to
 *  0 rather than poisoning the whole mesh with `NaN`. */
function normalizeNumberArray(raw: unknown): readonly number[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((value) => (typeof value === "number" && Number.isFinite(value) ? value : 0));
}

function normalizeBakedGeometry(raw: unknown): MeshAsset["geometry"] | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  return {
    position: normalizeNumberArray(raw["position"]),
    normal: normalizeNumberArray(raw["normal"]),
    uv: normalizeNumberArray(raw["uv"]),
    index: normalizeNumberArray(raw["index"]),
  };
}

/** Keeps only well-formed persisted mesh-asset library entries (name + baked geometry + byteSize);
 *  drops an entry whose geometry did not survive (ADR-0001: the arrays are the source of truth). */
function normalizeMeshAssets(raw: unknown): readonly MeshAsset[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const assets: MeshAsset[] = [];
  for (const value of raw) {
    if (!isRecord(value) || typeof value["name"] !== "string") {
      continue;
    }
    const geometry = normalizeBakedGeometry(value["geometry"]);
    if (geometry === undefined) {
      continue;
    }
    assets.push({
      name: value["name"],
      label: typeof value["label"] === "string" ? value["label"] : value["name"],
      geometry,
      byteSize: typeof value["byteSize"] === "number" ? value["byteSize"] : 0,
    });
  }
  return assets;
}

function normalizeEmitter(value: unknown): EmitterDoc | undefined {
  if (!isRecord(value) || typeof value["id"] !== "string") {
    return undefined;
  }
  const name = value["name"];
  return {
    id: value["id"],
    name: typeof name === "string" && name.trim() !== "" ? name : "Emitter",
    renderGraph: normalizeGraph(value["renderGraph"], GraphKind.Render),
    behaviorGraph: normalizeGraph(value["behaviorGraph"], GraphKind.Behavior),
    settings: normalizeSettings(value["settings"]),
    tracks: normalizeTracks(value["tracks"]),
    events: normalizeEvents(value["events"]),
    transform: normalizeTransform(value["transform"]),
    transformTracks: normalizeTransformTracks(value["transformTracks"]),
    liveChannels: normalizeLiveChannels(value["liveChannels"]),
    liveParams: normalizeLiveParams(value["liveParams"]),
    // See normalizeVfxMesh: omitted (not `false`) when not hidden, for a byte-for-byte round-trip.
    ...(value["hidden"] === true ? { hidden: true } : {}),
  };
}

/** Restores an emitter's spawn settings, defaulting missing/corrupt numeric fields. */
function normalizeSettings(raw: unknown): EmitterSettings {
  if (!isRecord(raw)) {
    return DEFAULT_EMITTER_SETTINGS;
  }
  return {
    spawnRate: asFiniteNumber(raw["spawnRate"], DEFAULT_EMITTER_SETTINGS.spawnRate),
  };
}

/** Restores the VFX group, defaulting documents authored before the group existed. */
function normalizeVfx(raw: unknown): VfxDoc {
  if (!isRecord(raw) || typeof raw["id"] !== "string") {
    return createDefaultVfx("vfx_1");
  }
  return {
    id: raw["id"],
    transform: normalizeTransform(raw["transform"]),
    transformTracks: normalizeTransformTracks(raw["transformTracks"]),
  };
}

/** A finite vec3 from `raw`, or `fallback` if any component is missing/non-finite. */
function readVec3(raw: unknown, fallback: Vec3): Vec3 {
  if (!Array.isArray(raw)) {
    return fallback;
  }
  const [x, y, z] = raw;
  return isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(z) ? [x, y, z] : fallback;
}

/** A finite quaternion from `raw`, or `fallback` if any component is missing/non-finite. */
function readVec4(raw: unknown, fallback: Quat): Quat {
  if (!Array.isArray(raw)) {
    return fallback;
  }
  const [x, y, z, w] = raw;
  return isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(z) && isFiniteNumber(w)
    ? [x, y, z, w]
    : fallback;
}

/** Restores an entity's base transform, defaulting any missing/corrupt field to identity. */
function normalizeTransform(raw: unknown): Transform {
  if (!isRecord(raw)) {
    return IDENTITY_TRANSFORM;
  }
  return {
    position: readVec3(raw["position"], IDENTITY_TRANSFORM.position),
    rotation: readVec4(raw["rotation"], IDENTITY_TRANSFORM.rotation),
    scale: readVec3(raw["scale"], IDENTITY_TRANSFORM.scale),
  };
}

/** Keeps only well-formed persisted transform tracks (one per known channel; corrupt keys dropped). */
function normalizeTransformTracks(raw: unknown): readonly TransformTrack[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const tracks: TransformTrack[] = [];
  for (const value of raw) {
    if (!isRecord(value) || !TRANSFORM_CHANNELS.includes(value["channel"] as TransformChannel)) {
      continue;
    }
    if (!Array.isArray(value["keys"])) {
      continue;
    }
    const keys = value["keys"].filter(isKeyframe).map((key) => ({
      id: typeof key["id"] === "string" ? key["id"] : nextIdentifier("key"),
      time: key["time"],
      value: key["value"],
    }));
    tracks.push({ channel: value["channel"] as TransformChannel, keys });
  }
  return tracks;
}

/** Keeps only well-formed persisted live-channel names (an unknown channel string is dropped). */
function normalizeLiveChannels(raw: unknown): readonly TransformChannel[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const channels = raw.filter((value): value is TransformChannel =>
    TRANSFORM_CHANNELS.includes(value as TransformChannel),
  );
  return [...new Set(channels)];
}

/** Keeps only well-formed persisted live-param names (a non-string entry is dropped). */
function normalizeLiveParams(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return [...new Set(raw.filter((value): value is string => typeof value === "string"))];
}

/** Restores the scene timeline settings, defaulting documents authored before they existed. */
function normalizeTimeline(raw: unknown): TimelineState {
  if (isRecord(raw) && isFiniteNumber(raw["duration"]) && raw["duration"] > 0) {
    return {
      duration: raw["duration"],
      fps: isFiniteNumber(raw["fps"]) && raw["fps"] > 0 ? raw["fps"] : DEFAULT_TIMELINE.fps,
    };
  }
  return DEFAULT_TIMELINE;
}

/** Keeps only well-formed persisted animation tracks (a corrupt track/key is dropped, not fatal). */
function normalizeTracks(raw: unknown): readonly AnimationTrack[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const tracks: AnimationTrack[] = [];
  for (const value of raw) {
    if (isRecord(value) && typeof value["name"] === "string" && Array.isArray(value["keys"])) {
      const keys = value["keys"].filter(isKeyframe).map((key) => ({
        id: typeof key["id"] === "string" ? key["id"] : nextIdentifier("key"),
        time: key["time"],
        value: key["value"],
      }));
      tracks.push({ name: value["name"], keys });
    }
  }
  return tracks;
}

/** Keeps only well-formed persisted spawn events (a corrupt event is dropped, not fatal). */
function normalizeEvents(raw: unknown): readonly TimelineEvent[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const events: TimelineEvent[] = [];
  for (const value of raw) {
    if (!isRecord(value) || typeof value["id"] !== "string") {
      continue;
    }
    const time = value["time"];
    if (!isFiniteNumber(time)) {
      continue;
    }
    if (value["kind"] === "burst" && isFiniteNumber(value["count"])) {
      events.push({ id: value["id"], kind: "burst", time, count: value["count"] });
    } else if (
      value["kind"] === "play" &&
      isFiniteNumber(value["rate"]) &&
      isFiniteNumber(value["duration"])
    ) {
      events.push({
        id: value["id"],
        kind: "play",
        time,
        rate: value["rate"],
        duration: value["duration"],
      });
    }
  }
  return events.sort((a, b) => a.time - b.time);
}

/** A persisted keyframe is a finite `time` and a value that is a finite number or number array. */
function isKeyframe(raw: unknown): raw is { id?: unknown; time: number; value: number | number[] } {
  if (!isRecord(raw) || !isFiniteNumber(raw["time"])) {
    return false;
  }
  const value = raw["value"];
  return isFiniteNumber(value) || (Array.isArray(value) && value.every(isFiniteNumber));
}
