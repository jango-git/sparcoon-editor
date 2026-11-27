/**
 * Turns whatever `loadSource()` returns (a valid document, or corrupt/absent storage) into a valid
 * {@link EditorState}, defaulting every missing or malformed field so a garbled localStorage entry
 * can never crash startup - it falls back to a fresh document instead.
 */

import { asEmissionBasis, asKeyEase, asParticleEventKind } from "sparcoon/editor";

import { createEmptyGraph, type EditorGraph } from "../domain/graphModel";
import {
  DEFAULT_RENDER_HOST,
  GraphKind,
  NON_STRIP_SURFACE_SLOTS,
  PARTICLE_ONLY_SURFACE_SLOTS,
  type RenderHost,
  type StripHost,
} from "../domain/nodePalette";
import { withValidReactions } from "../domain/reactions";
import { ensureSinks } from "../domain/sinks";
import {
  seedIdentifierCounterFromRawSource,
  seedIdentifierCounterFromSource,
} from "../model/commands/documentIdentifiers";
import { nextIdentifier } from "../model/commands/identifier";
import {
  type AnimationTrack,
  type BakedBone,
  type BakedClip,
  type BakedMeshSkin,
  type BakedTrack,
  BUILT_IN_SCENE_NAMES,
  createDefaultVfx,
  DEFAULT_TIMELINE,
  type EditorState,
  emissionBasisField,
  type EmitterDoc,
  emitterGraphs,
  type EnvironmentAsset,
  isSceneName,
  type Keyframe,
  MATRIX_FLOATS,
  type MeshAsset,
  meshGraphs,
  type PaletteSwatch,
  type Reaction,
  type SceneAsset,
  type SourceState,
  type SpawnAction,
  STUDIO_SCENE_NAME,
  type TextureAsset,
  type TimelineEvent,
  type TimelineState,
  type VfxDoc,
  type VfxMeshDoc,
  type VolumeAsset,
} from "../model/editorState";
import { withDeclaredTimelineValues } from "../model/timelineValues";
import {
  IDENTITY_TRANSFORM,
  type Quat,
  type Transform,
  TRANSFORM_CHANNELS,
  type TransformChannel,
  type TransformTrack,
  type Vec3,
} from "../model/transform";
import { arrayBufferBytes } from "../util/bytes";
import { asOptionalString, isFiniteNumber, isRecord } from "../util/guards";
import { hydrateSource, loadSource } from "./localStore";
import { decodeSourcePayloads } from "./payloadCodec";
import type { LoadedPreset } from "./presets";
import {
  isNewerProject,
  type StoredProject,
  unwrapProject,
  upgradeProject,
} from "./projectEnvelope";

/** The state the editor starts with, and the preset it was loaded from when nothing valid was in
 *  storage. */
export interface InitialState {
  readonly state: EditorState;
  readonly preset: LoadedPreset | undefined;
}

/** `loadFallback` is called (and awaited) only when nothing valid is in storage, so a returning
 *  user with an existing document never pays for it. */
export async function loadInitialState(
  loadFallback: () => Promise<LoadedPreset>,
): Promise<InitialState> {
  const restored = await restoreSource();
  if (restored !== undefined) {
    return startingWith(restored, undefined);
  }
  const preset = await loadFallback();
  return startingWith(preset.source, preset);
}

function startingWith(source: SourceState, preset: LoadedPreset | undefined): InitialState {
  seedIdentifierCounterFromSource(source);
  return { state: { source, derived: {} }, preset };
}

/** The persisted document, defended down to a valid source, or `undefined` to start fresh. */
async function restoreSource(): Promise<SourceState | undefined> {
  try {
    const stored = unwrapProject(loadSource());
    if (isNewerProject(stored)) {
      // Unlike a file, refusing it would lose it: the next autosave writes over it.
      console.warn(
        `The saved document is from a later editor (${stored.editor ?? "unknown"}); keeping what this one reads`,
      );
    }
    const normalized = await readStoredSource(stored);
    return normalized === undefined ? undefined : await hydrateSource(normalized);
  } catch (error) {
    // Filling the asset payloads back in can still throw: start fresh rather than brick the editor.
    console.warn("Discarding an unreadable saved document; starting fresh", error);
    return undefined;
  }
}

/** The valid source a stored project holds, upgraded to the current format with its payloads
 *  decoded, or `undefined` - also when an upgrade step or the normalization throws on a damaged
 *  body. */
export async function readStoredSource(stored: StoredProject): Promise<SourceState | undefined> {
  try {
    const body = await decodeSourcePayloads(upgradeProject(stored));
    // Seed from the raw body *before* normalizing: normalization can itself backfill a missing id
    // (see seedIdentifierCounterFromRawSource's doc), so seeding only afterward is too late.
    seedIdentifierCounterFromRawSource(body);
    return normalizeSource(body);
  } catch (error) {
    console.warn("A stored project failed to load", error);
    return undefined;
  }
}

/** Guarantees a persisted graph's structural containers so a missing/non-object field can't crash
 *  {@link ensureSinks}. Node/connection *contents* are trusted as-is - a bad one is a graph error. */
function normalizeGraph(
  raw: unknown,
  kind: GraphKind,
  host: RenderHost = DEFAULT_RENDER_HOST,
): EditorGraph {
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
  return ensureSinks(graph, kind, host);
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
  // Reactions last, across the whole scene: a source must survive, and none may close a cycle.
  const emitters = withValidReactions(
    rawEmitters
      .map(normalizeEmitter)
      .filter((emitter): emitter is EmitterDoc => emitter !== undefined),
  );
  const meshes = normalizeMeshes(scene["meshes"]);
  // An effect may be meshes only, but not nothing at all.
  if (emitters.length === 0 && meshes.length === 0) {
    return undefined;
  }
  const active = emitters.find((emitter) => emitter.id === scene["activeEmitterId"]);
  const activeMesh = meshes.find((mesh) => mesh.id === scene["activeMeshId"]);
  const activeMeshId = activeMesh?.id ?? meshes[0]?.id;
  // The graph editor targets a mesh when it was persisted as such AND a mesh survives, or when no
  // emitter does; a dangling "vfxMesh" (all meshes dropped) falls back to the active emitter.
  const activeGraphKind =
    activeMeshId !== undefined && (scene["activeGraphKind"] === "vfxMesh" || emitters.length === 0)
      ? "vfxMesh"
      : "emitter";
  const scenes = normalizeScenes(raw["scenes"]);
  return {
    name: typeof raw["name"] === "string" ? raw["name"] : "",
    scene: {
      vfx: normalizeVfx(scene["vfx"]),
      emitters,
      activeEmitterId: active?.id ?? emitters[0]?.id,
      meshes,
      // A scene may hold zero meshes, so `activeMeshId` stays undefined when none survive; otherwise
      // it falls to the first surviving mesh if the persisted active id has gone stale.
      activeMeshId,
      activeGraphKind,
    },
    assets: normalizeAssets(raw["assets"]),
    environments: normalizeFileAssets(raw["environments"]),
    activeEnvironmentName: asOptionalString(raw["activeEnvironmentName"]),
    scenes,
    activeSceneName: normalizeActiveSceneName(raw["activeSceneName"], scenes),
    meshAssets: normalizeMeshAssets(raw["meshAssets"]),
    volumeAssets: normalizeVolumeAssets(raw["volumeAssets"]),
    palette: normalizePalette(raw["palette"]),
    timeline: normalizeTimeline(raw["timeline"]),
  };
}

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

/** Drops strip-graph bindings to a slot the strip targets lack (the particle transforms). */
function pruneNonStripBindings(graph: EditorGraph): EditorGraph {
  const kept = graph.outputBindings.filter((binding) => !NON_STRIP_SURFACE_SLOTS.has(binding.slot));
  return kept.length === graph.outputBindings.length ? graph : { ...graph, outputBindings: kept };
}

/** A persisted trail or ribbon graph: normalized on its host, minus what a strip has no place for. */
function normalizeStripGraph(raw: unknown, host: StripHost): EditorGraph {
  return pruneNonStripBindings(normalizeGraph(raw, GraphKind.Render, host));
}

function normalizeVfxMesh(value: unknown): VfxMeshDoc | undefined {
  if (!isRecord(value) || typeof value["id"] !== "string") {
    return undefined;
  }
  const name = value["name"];
  const mesh: VfxMeshDoc = {
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
  return withDeclaredTimelineValues(mesh, meshGraphs(mesh));
}

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

function vec3(raw: unknown): readonly [number, number, number] | undefined {
  return Array.isArray(raw) && raw.length === 3 && raw.every(isFiniteNumber)
    ? [raw[0] as number, raw[1] as number, raw[2] as number]
    : undefined;
}

/** Keeps only well-formed persisted volume-asset library entries (a positive integer size, a box
 *  and a distance encoding). The payload may be empty, filled back in from the blob store. */
function normalizeVolumeAssets(raw: unknown): readonly VolumeAsset[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const assets: VolumeAsset[] = [];
  for (const value of raw) {
    if (!isRecord(value) || typeof value["name"] !== "string") {
      continue;
    }
    const size = vec3(value["size"]);
    const boxMin = vec3(value["boxMin"]);
    const boxMax = vec3(value["boxMax"]);
    const { scale, bias, dataUrl } = value;
    if (
      size === undefined ||
      !size.every((count) => Number.isInteger(count) && count > 0) ||
      boxMin === undefined ||
      boxMax === undefined ||
      !isFiniteNumber(scale) ||
      !isFiniteNumber(bias) ||
      typeof dataUrl !== "string"
    ) {
      continue;
    }
    assets.push({
      name: value["name"],
      label: typeof value["label"] === "string" ? value["label"] : value["name"],
      dataUrl,
      size,
      boxMin,
      boxMax,
      scale,
      bias,
    });
  }
  return assets;
}

/** Keeps the well-formed file assets (HDRIs, scenes): a name, decoded `bytes` and a byte size. The
 *  bytes may be empty, filled back in from the blob store. */
function normalizeFileAssets(raw: unknown): readonly (EnvironmentAsset & SceneAsset)[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const assets: (EnvironmentAsset & SceneAsset)[] = [];
  for (const value of raw) {
    const bytes = isRecord(value) ? arrayBufferBytes(value["bytes"]) : undefined;
    if (
      isRecord(value) &&
      typeof value["name"] === "string" &&
      bytes !== undefined &&
      typeof value["byteSize"] === "number"
    ) {
      assets.push({
        name: value["name"],
        label: typeof value["label"] === "string" ? value["label"] : value["name"],
        bytes,
        byteSize: value["byteSize"],
      });
    }
  }
  return assets;
}

/** Scenes whose name a built-in scene does not take. */
function normalizeScenes(raw: unknown): readonly SceneAsset[] {
  return normalizeFileAssets(raw).filter((asset) => !BUILT_IN_SCENE_NAMES.includes(asset.name));
}

/** The active scene's name when a built-in or an uploaded scene has it, else the studio. */
function normalizeActiveSceneName(raw: unknown, scenes: readonly SceneAsset[]): string {
  return typeof raw === "string" && isSceneName(raw, scenes) ? raw : STUDIO_SCENE_NAME;
}

/** The floats in `bytes`, a non-finite one read as 0; `undefined` when `bytes` is not whole floats. */
function floatsOf(bytes: unknown): Float32Array<ArrayBuffer> | undefined {
  if (!(bytes instanceof Uint8Array) || bytes.length % 4 !== 0) {
    return undefined;
  }
  const floats = new Float32Array(bytes.slice().buffer);
  return floats.map((value) => (Number.isFinite(value) ? value : 0));
}

function indicesOf(bytes: unknown): Uint32Array<ArrayBuffer> | undefined {
  return bytes instanceof Uint8Array && bytes.length % 4 === 0
    ? new Uint32Array(bytes.slice().buffer)
    : undefined;
}

function normalizeBakedGeometry(raw: unknown): MeshAsset["geometry"] | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const position = floatsOf(raw["position"]);
  const normal = floatsOf(raw["normal"]);
  const uv = floatsOf(raw["uv"]);
  const index = indicesOf(raw["index"]);
  if (position === undefined || normal === undefined || uv === undefined || index === undefined) {
    return undefined;
  }
  const skin = normalizeBakedSkin(raw["skin"], position.length / 3);
  const matrix = raw["matrix"];
  return {
    position,
    normal,
    uv,
    index,
    ...(isMatrix(matrix) ? { matrix } : {}),
    ...(skin === undefined ? {} : { skin }),
  };
}

function isMatrix(raw: unknown): raw is readonly number[] {
  return Array.isArray(raw) && raw.length === MATRIX_FLOATS && raw.every(isFiniteNumber);
}

const IDENTITY_MATRIX: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** `raw` if it is a matrix, else the identity. */
function matrixOr(raw: unknown): readonly number[] {
  return isMatrix(raw) ? raw : IDENTITY_MATRIX;
}

/** A well-formed skin of a mesh of `vertices` vertices, else `undefined`: the mesh then loads
 *  unskinned. */
function normalizeBakedSkin(raw: unknown, vertices: number): BakedMeshSkin | undefined {
  if (!isRecord(raw) || !Array.isArray(raw["bones"]) || !Array.isArray(raw["clips"])) {
    return undefined;
  }
  const skinIndex = floatsOf(raw["skinIndex"]);
  const skinWeight = floatsOf(raw["skinWeight"]);
  const boneInverses = floatsOf(raw["boneInverses"]);
  const bones = raw["bones"].map(normalizeBakedBone);
  const count = bones.length;
  if (
    skinIndex?.length !== vertices * 4 ||
    skinWeight?.length !== vertices * 4 ||
    boneInverses?.length !== count * MATRIX_FLOATS ||
    count === 0 ||
    bones.some((bone) => bone === undefined || bone.parent >= count)
  ) {
    return undefined;
  }
  return {
    skinIndex,
    skinWeight,
    bindMatrix: matrixOr(raw["bindMatrix"]),
    bones: bones as BakedBone[],
    boneInverses,
    clips: raw["clips"].flatMap((clip) => normalizeBakedClip(clip) ?? []),
  };
}

function normalizeBakedBone(raw: unknown): BakedBone | undefined {
  if (
    !isRecord(raw) ||
    typeof raw["name"] !== "string" ||
    !Number.isInteger(raw["parent"]) ||
    (raw["parent"] as number) < -1 ||
    !isMatrix(raw["matrix"])
  ) {
    return undefined;
  }
  const parentMatrix = raw["parentMatrix"];
  return {
    name: raw["name"],
    parent: raw["parent"] as number,
    matrix: raw["matrix"],
    ...(isMatrix(parentMatrix) ? { parentMatrix } : {}),
  };
}

function normalizeBakedClip(raw: unknown): BakedClip | undefined {
  if (
    !isRecord(raw) ||
    typeof raw["name"] !== "string" ||
    !isFiniteNumber(raw["duration"]) ||
    !Array.isArray(raw["tracks"])
  ) {
    return undefined;
  }
  const tracks = raw["tracks"].flatMap((track: unknown): BakedTrack[] => {
    if (!isRecord(track) || typeof track["name"] !== "string") {
      return [];
    }
    const times = floatsOf(track["times"]);
    const values = floatsOf(track["values"]);
    const interpolation = track["interpolation"] === "discrete" ? "discrete" : "linear";
    return times === undefined || values === undefined || times.length === 0
      ? []
      : [{ name: track["name"], interpolation, times, values }];
  });
  return { name: raw["name"], duration: raw["duration"], tracks };
}

/** Keeps well-formed mesh assets. An entry whose geometry did not survive is dropped, since the
 *  geometry is the source of truth. */
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
      ...(value["shownInScene"] === true ? { shownInScene: true } : {}),
      ...(typeof value["clip"] === "string" ? { clip: value["clip"] } : {}),
    });
  }
  return assets;
}

/** A finite linear-RGBA tuple from `raw`, defaulting a missing/non-finite channel to opaque black -
 *  a corrupt swatch degrades instead of poisoning the whole palette with `NaN`. */
function normalizePaletteColor(raw: unknown): PaletteSwatch["color"] {
  const channel = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  const [r, g, b, a] = Array.isArray(raw) ? raw : [];
  return [
    channel(r),
    channel(g),
    channel(b),
    Array.isArray(raw) && raw.length > 3 ? channel(a) : 1,
  ];
}

/** Keeps only well-formed persisted palette swatches (name + label + a readable color). */
function normalizePalette(raw: unknown): readonly PaletteSwatch[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const swatches: PaletteSwatch[] = [];
  for (const value of raw) {
    if (!isRecord(value) || typeof value["name"] !== "string") {
      continue;
    }
    const label = value["label"];
    swatches.push({
      name: value["name"],
      label: typeof label === "string" && label.trim() !== "" ? label : value["name"],
      color: normalizePaletteColor(value["color"]),
    });
  }
  return swatches;
}

function normalizeEmitter(value: unknown): EmitterDoc | undefined {
  if (!isRecord(value) || typeof value["id"] !== "string") {
    return undefined;
  }
  const name = value["name"];
  const emitter: EmitterDoc = {
    id: value["id"],
    name: typeof name === "string" && name.trim() !== "" ? name : "Emitter",
    renderGraph: normalizeGraph(value["renderGraph"], GraphKind.Render),
    behaviorGraph: normalizeGraph(value["behaviorGraph"], GraphKind.Behavior),
    // Omitted when the emitter has no trail or ribbon, like `hidden` below.
    ...(isRecord(value["trailGraph"])
      ? { trailGraph: normalizeStripGraph(value["trailGraph"], "trail") }
      : {}),
    ...(isRecord(value["ribbonGraph"])
      ? { ribbonGraph: normalizeStripGraph(value["ribbonGraph"], "ribbon") }
      : {}),
    tracks: normalizeTracks(value["tracks"]),
    events: normalizeEvents(value["events"]),
    reactions: normalizeReactions(value["reactions"]),
    transform: normalizeTransform(value["transform"]),
    transformTracks: normalizeTransformTracks(value["transformTracks"]),
    liveChannels: normalizeLiveChannels(value["liveChannels"]),
    liveParams: normalizeLiveParams(value["liveParams"]),
    ...(value["liveEvents"] === true ? { liveEvents: true } : {}),
    // See normalizeVfxMesh: omitted (not `false`) when not hidden, for a byte-for-byte round-trip.
    ...(value["hidden"] === true ? { hidden: true } : {}),
  };
  return withDeclaredTimelineValues(emitter, emitterGraphs(emitter));
}

/** Restores the VFX group; a missing one gets the default. */
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
    const keys = value["keys"].filter(isKeyframe).map(normalizeKeyframe);
    tracks.push({ channel: value["channel"] as TransformChannel, keys });
  }
  return tracks;
}

function normalizeLiveChannels(raw: unknown): readonly TransformChannel[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const channels = raw.filter((value): value is TransformChannel =>
    TRANSFORM_CHANNELS.includes(value as TransformChannel),
  );
  return [...new Set(channels)];
}

function normalizeLiveParams(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return [...new Set(raw.filter((value): value is string => typeof value === "string"))];
}

/** Restores the scene timeline settings; missing fields get defaults. */
function normalizeTimeline(raw: unknown): TimelineState {
  if (isRecord(raw) && isFiniteNumber(raw["duration"]) && raw["duration"] > 0) {
    return {
      duration: raw["duration"],
      fps: isFiniteNumber(raw["fps"]) && raw["fps"] > 0 ? raw["fps"] : DEFAULT_TIMELINE.fps,
      // A project saved before the setting existed looped, as every timeline then did.
      loop: raw["loop"] !== false,
    };
  }
  return DEFAULT_TIMELINE;
}

function normalizeTracks(raw: unknown): readonly AnimationTrack[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const tracks: AnimationTrack[] = [];
  for (const value of raw) {
    if (isRecord(value) && typeof value["name"] === "string" && Array.isArray(value["keys"])) {
      const keys = value["keys"].filter(isKeyframe).map(normalizeKeyframe);
      tracks.push({ name: value["name"], keys });
    }
  }
  return tracks;
}

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
    const action = normalizeSpawnAction(value);
    if (isFiniteNumber(time) && action !== undefined) {
      events.push({ ...action, id: value["id"], time });
    }
  }
  return events.sort((a, b) => a.time - b.time);
}

/**
 * Keeps only well-formed persisted reactions (a corrupt one is dropped, not fatal - and so is a play
 * without end or over distance, which no reaction may be, and one naming no particle event). One
 * saved before birth reactions existed names none and fires on deaths. Whether each source exists,
 * and cycles, are checked across the scene ({@link withValidReactions}).
 */
function normalizeReactions(raw: unknown): readonly Reaction[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const reactions: Reaction[] = [];
  for (const value of raw) {
    if (!isRecord(value) || typeof value["id"] !== "string") {
      continue;
    }
    const source = value["source"];
    const on = value["on"] === undefined ? "death" : asParticleEventKind(value["on"]);
    const action = normalizeSpawnAction(value);
    if (
      typeof source === "string" &&
      on !== undefined &&
      action !== undefined &&
      (action.kind === "burst" || (action.duration > 0 && action.over === undefined))
    ) {
      reactions.push({ ...action, id: value["id"], source, on });
    }
  }
  return reactions;
}

/** The spawn action a persisted event or reaction carries, if well-formed. */
function normalizeSpawnAction(value: Record<string, unknown>): SpawnAction | undefined {
  if (value["kind"] === "burst" && isFiniteNumber(value["count"])) {
    return { kind: "burst", count: value["count"] };
  }
  if (
    value["kind"] === "play" &&
    isFiniteNumber(value["rate"]) &&
    isFiniteNumber(value["duration"])
  ) {
    return {
      kind: "play",
      rate: value["rate"],
      duration: value["duration"],
      // An unknown or missing basis reads as the default, time.
      ...emissionBasisField(asEmissionBasis(value["over"]) ?? "time"),
    };
  }
  return undefined;
}

/**
 * A well-formed persisted keyframe as the model holds it: a missing id backfilled, an unknown
 * curve dropped (so the key reads as linear).
 */
function normalizeKeyframe(key: {
  id?: unknown;
  ease?: unknown;
  time: number;
  value: number | number[];
}): Keyframe {
  const ease = asKeyEase(key.ease);
  return {
    id: typeof key.id === "string" ? key.id : nextIdentifier("key"),
    time: key.time,
    value: key.value,
    ...(ease !== undefined && ease !== "linear" ? { ease } : {}),
  };
}

/** A persisted keyframe is a finite `time` and a value that is a finite number or number array. */
function isKeyframe(raw: unknown): raw is { id?: unknown; time: number; value: number | number[] } {
  if (!isRecord(raw) || !isFiniteNumber(raw["time"])) {
    return false;
  }
  const value = raw["value"];
  return isFiniteNumber(value) || (Array.isArray(value) && value.every(isFiniteNumber));
}
