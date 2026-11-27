/**
 * State is split into `source` and `derived`.
 *
 * - `source` is what the user authored. It is saved and is the only part in the undo history.
 * - `derived` is computed from `source`, never saved, never in history, and recomputed by the
 * pipeline on every structural edit.
 */

import type { FXEmissionBasis, FXKeyEase, FXParticleEventKind, FXSpawnAction } from "sparcoon";

import type {
  EditorGraph,
  GraphConnection,
  GraphNode,
  GraphOutputBinding,
} from "../domain/graphModel";
import { createEmptyGraph } from "../domain/graphModel";
import { DEFAULT_RENDER_HOST, GraphKind, type RenderHost } from "../domain/nodePalette";
import { ensureSinks } from "../domain/sinks";
import type { FXCompilerError } from "../engine/core/compiler/FXCompilerError";
import type { FXGraphSnapshotData } from "../engine/core/live/FXSnapshotData";
import { authoredGraphs } from "./graphSlots";
import {
  IDENTITY_TRANSFORM,
  type Transform,
  type TransformChannel,
  type TransformTrack,
} from "./transform";

/** One baked keyframe: a Timeline Value's value at a point in time (seconds on the timeline). */
export interface Keyframe {
  /** Stable id, so the timeline can select, move and inspect a key across edits. */
  readonly id: string;
  readonly time: number;
  readonly value: number | readonly number[];
  /** The curve from this key to the next (the runtime's own); linear when absent. */
  readonly ease?: FXKeyEase;
}

/**
 * The keyframes for one animated Timeline Value, keyed by the value's **param name** (the same
 * name that derives its uniform/binding slot). Keys are kept sorted by `time`. Authoring data only -
 * it never reaches the compiler; `TimelineDispatcher` samples it each frame and scrubs the value
 * into the running emitter.
 *
 * Whether a name is "live" is entity-level metadata (`EmitterDoc.liveParams`), not a track field -
 * a track's existence here is purely "does this param have keyframes", independent of liveness.
 */
export interface AnimationTrack {
  readonly name: string;
  readonly keys: readonly Keyframe[];
}

/**
 * The runtime's `FXSpawnAction`. `burst` spawns `count` particles at once. `play` emits `rate`
 * particles per second, or per world unit the emitter travels with `over: "distance"` (timeline
 * events only), for `duration` seconds (`0` means no end, timeline events only).
 */
export type SpawnAction = FXSpawnAction;

/** The `over` field a play counting per `over` carries: none for `"time"` (see {@link SpawnAction}). */
export function emissionBasisField(over: FXEmissionBasis): { readonly over?: FXEmissionBasis } {
  return over === "time" ? {} : { over };
}
export type BurstAction = Extract<SpawnAction, { readonly kind: "burst" }>;
export type PlayAction = Extract<SpawnAction, { readonly kind: "play" }>;

/**
 * A timeline **spawn event** on one emitter: its action, fired as the playhead crosses `time`.
 * Events carry an `id` so they can be retimed and edited in place.
 */
export interface BurstEvent extends BurstAction {
  readonly id: string;
  readonly time: number;
}

export interface PlayEvent extends PlayAction {
  readonly id: string;
  readonly time: number;
}

export type TimelineEvent = BurstEvent | PlayEvent;

/** What a reaction holds besides its action: its id, its source and which of the source's
 *  particle events fires it. */
interface ReactionTrigger {
  readonly id: string;
  /** The id of the emitter whose particles' births or deaths fire it. */
  readonly source: string;
  readonly on: FXParticleEventKind;
}

/**
 * A **reaction** on one emitter: its action, fired at every birth or death of the `source`
 * emitter's particles, from where the particle was born or died (the runtime's `connectReaction`).
 * Not on the time axis. A play here always has a finite duration, and the reactions of a scene
 * never form a cycle, whatever events they fire on (see domain/reactions.ts).
 */
export interface BurstReaction extends BurstAction, ReactionTrigger {}

/** A reaction's play counts over time only: it spawns from where a particle was born or died,
 *  which does not move. */
export interface PlayReaction extends Omit<PlayAction, "over">, ReactionTrigger {}

export type Reaction = BurstReaction | PlayReaction;

/**
 * One emitter object in the scene. Each emitter owns its **own** pair of authored
 * graphs (render + behavior) and its emitter-level settings - the graph editor edits
 * the active emitter's pair, and the preview drives one runtime emitter per doc.
 */
export interface EmitterDoc {
  readonly id: string;
  readonly name: string;
  readonly renderGraph: EditorGraph;
  readonly behaviorGraph: EditorGraph;
  /** Trail graph, compiled against the trail target. Omitted when the emitter has no trail. */
  readonly trailGraph?: EditorGraph;
  /**
   * The emitter's ribbon graph - a band through its particles in the order they were born. A
   * render-kind graph compiled against the ribbon target; omitted when the emitter has no ribbon,
   * like {@link trailGraph}.
   */
  readonly ribbonGraph?: EditorGraph;
  /** This emitter's animation tracks (one per animated Timeline Value); the timeline shows them. */
  readonly tracks: readonly AnimationTrack[];
  /** This emitter's timeline spawn events (burst / play), sorted by time; the timeline drives them. */
  readonly events: readonly TimelineEvent[];
  /**
   * What this emitter spawns when other emitters' particles are born or die. With {@link events}, the only
   * things that make an emitter spawn - a fresh emitter is idle until one fires.
   */
  readonly reactions: readonly Reaction[];
  /** The emitter's local transform (relative to the VFX group), edited by the preview gizmo. */
  readonly transform: Transform;
  /** Keyframes animating this emitter's transform channels (position / rotation / scale). */
  readonly transformTracks: readonly TransformTrack[];
  /**
   * Transform channels excluded from the TS export and left for the consumer to pose directly
   * through the exported effect's `getEmitter`/`getMesh`.
   * Independent of `transformTracks` - a channel can be live with or without keyframes (any
   * keyframes just never reach the export), so marking/unmarking never depends on track existence.
   */
  readonly liveChannels: readonly TransformChannel[];
  /** Timeline Value names excluded from the export and driven only through `setEmitterParam`/
   * `setMeshParam` instead. See {@link liveChannels} - independent of `tracks`. */
  readonly liveParams: readonly string[];
  /**
   * Spawn events are played in the editor only. The export ships none, and host code spawns through
   * `getEmitter(name).burst` or `play`. Omitted (not `false`) when off.
   */
  readonly liveEvents?: true;
  /** Hidden in the preview + outline. Editor-only - never affects the TS export. */
  readonly hidden?: boolean;
}

/**
 * Every graph an emitter authors: render, behavior, and the trail and ribbon when it has them - one parameter
 * namespace across all of them (a Timeline Value name drives every graph that declares it).
 */
export function emitterGraphs(emitter: EmitterDoc): readonly EditorGraph[] {
  return authoredGraphs(emitter).map(({ graph }) => graph);
}

/** Every graph a mesh authors: its render graph. */
export function meshGraphs(mesh: VfxMeshDoc): readonly EditorGraph[] {
  return [mesh.renderGraph];
}

/**
 * The single group that owns every emitter in the scene, with a transform and transform tracks so
 * the whole effect can be posed and animated as one unit.
 *
 * It has no `liveChannels` because all three transform channels are always live (`entity.kind ===
 * "vfx"` is special-cased in `setLiveChannel` and in the exporter's root specification). It has no
 * `name` either, because it shows the project name (`SourceState.name`, via `projectDisplayName`).
 */
export interface VfxDoc {
  readonly id: string;
  readonly transform: Transform;
  readonly transformTracks: readonly TransformTrack[];
}

/**
 * A mesh with a render graph and no simulation: no behavior graph, attributes, spawn settings or
 * spawn events. It renders one primitive (chosen by the surface sink's Geometry param) and is posed
 * by its transform. It can animate render-graph params through `tracks`.
 */
export interface VfxMeshDoc {
  readonly id: string;
  readonly name: string;
  readonly renderGraph: EditorGraph;
  /** Animation tracks for this mesh's render-graph Timeline Values (the timeline shows them). */
  readonly tracks: readonly AnimationTrack[];
  /** The mesh's local transform (relative to the VFX group), edited by the preview gizmo. */
  readonly transform: Transform;
  /** Keyframes animating this mesh's transform channels (position / rotation / scale). */
  readonly transformTracks: readonly TransformTrack[];
  /** See {@link EmitterDoc.liveChannels}. */
  readonly liveChannels: readonly TransformChannel[];
  /** See {@link EmitterDoc.liveParams}. */
  readonly liveParams: readonly string[];
  /** Hidden in the preview + outline. Editor-only - never affects the TS export. */
  readonly hidden?: boolean;
}

/** Which kind of object the shared graph editor currently targets (its render/behavior graphs). */
export type GraphOwnerKind = "emitter" | "vfxMesh";

/**
 * The scene: the VFX group, its emitters and VFX meshes, and which object the editor targets for
 * graph editing (`activeGraphKind` + `activeEmitterId`/`activeMeshId`; see {@link resolveGraphOwner}).
 */
export interface SceneModel {
  readonly vfx: VfxDoc;
  readonly emitters: readonly EmitterDoc[];
  readonly activeEmitterId?: string | undefined;
  readonly meshes: readonly VfxMeshDoc[];
  readonly activeMeshId?: string | undefined;
  readonly activeGraphKind: GraphOwnerKind;
}

/** A reference to the active graph owner: which emitter or VFX mesh the shared canvas edits. */
export interface GraphOwnerRef {
  readonly kind: GraphOwnerKind;
  readonly id: string;
}

/**
 * Resolves which owner the shared graph canvas edits: the `activeMeshId` mesh when `activeGraphKind`
 * names one that still exists, else the active emitter (falling back to the first when the id is
 * stale), else - in a scene of meshes only - the active or first mesh. `undefined` only for a scene
 * with no object at all, which the commands never leave. The single resolver every read (selectors)
 * and write (graph commands) path shares, so none can target a different owner than another.
 */
export function resolveGraphOwner(scene: SceneModel): GraphOwnerRef | undefined {
  if (scene.activeGraphKind === "vfxMesh") {
    const mesh = scene.meshes.find((candidate) => candidate.id === scene.activeMeshId);
    if (mesh !== undefined) {
      return { kind: "vfxMesh", id: mesh.id };
    }
  }
  const emitterId = scene.emitters.some((emitter) => emitter.id === scene.activeEmitterId)
    ? scene.activeEmitterId
    : scene.emitters[0]?.id;
  if (emitterId !== undefined) {
    return { kind: "emitter", id: emitterId };
  }
  const meshId =
    scene.meshes.find((candidate) => candidate.id === scene.activeMeshId)?.id ??
    scene.meshes[0]?.id;
  return meshId !== undefined ? { kind: "vfxMesh", id: meshId } : undefined;
}

/**
 * Whether one of the scene's objects (an emitter or a VFX mesh) may be removed: any may, as long
 * as one is left - an effect of meshes only, or emitters only, is fine; an empty one is not.
 */
export function canRemoveObject(scene: SceneModel): boolean {
  return scene.emitters.length + scene.meshes.length > 1;
}

/** Scene-wide timeline settings (authored). One shared playhead runs over `[0, duration)`. */
export interface TimelineState {
  /** Total timeline length in seconds; playback loops back to 0 at the end, unless `loop` is off. */
  readonly duration: number;
  /** Frame rate: the caret, keyframes and events snap to this frame grid (frames/second). */
  readonly fps: number;
  /**
   * Whether the effect loops (seamlessly, in the preview and the export alike) or plays once and
   * holds its last frame - the exported effect then dispatches `"finished"` at the end.
   */
  readonly loop: boolean;
}

/**
 * A raster image. `name` is a unique param identifier (`^[a-z][A-Za-z0-9]*`) that a Texture node
 * references and that gives the uniform `u_param_<name>`. `label` is the original file name and
 * `dataUrl` the base64 image.
 */
export interface TextureAsset {
  readonly name: string;
  readonly label: string;
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
}

/**
 * An HDRI environment, usable as viewport background and light. `name` is a unique key. `label` is
 * the file name, `bytes` the uploaded `.hdr` file, `byteSize` its size.
 */
export interface EnvironmentAsset {
  readonly name: string;
  readonly label: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly byteSize: number;
}

/**
 * A preview scene uploaded as a GLB, drawn around the effect in place of the studio ground. Scene
 * depth and the sun's shadows include it as they include the ground, and it never reaches the
 * exported effect. `name` is a unique key, `label` the file name, `bytes` the uploaded file,
 * `byteSize` its size.
 */
export interface SceneAsset {
  readonly name: string;
  readonly label: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly byteSize: number;
}

/** The scene every project has: the studio ground. */
export const STUDIO_SCENE_NAME = "studio";
export const BUILT_IN_SCENE_NAMES: readonly string[] = [STUDIO_SCENE_NAME];

/** Whether `name` is a built-in scene's or one of `scenes`. */
export function isSceneName(name: string, scenes: readonly SceneAsset[]): boolean {
  return BUILT_IN_SCENE_NAMES.includes(name) || scenes.some((asset) => asset.name === name);
}

/**
 * A saved color swatch. `name` is a unique key from `nextIdentifier("swatch")`, `label` is its hex
 * at save time, `color` is linear RGBA with channels 0..1.
 */
export interface PaletteSwatch {
  readonly name: string;
  readonly label: string;
  readonly color: readonly [number, number, number, number];
}

/**
 * Baked geometry: flat `position` and `normal` (vec3) and `uv` (vec2) arrays plus a triangle
 * `index` array, the same subset {@link buildPrimitiveGeometry} produces, the mesh's world matrix
 * in its file's scene (`matrix`, {@link MATRIX_FLOATS} floats, the identity when omitted), and the
 * skin of a skinned mesh. No tangents, vertex colors, extra UV sets or morph targets. The uploaded
 * GLB's bytes are not kept, so this data is the source.
 */
export interface BakedMeshGeometry {
  readonly position: Float32Array<ArrayBuffer>;
  readonly normal: Float32Array<ArrayBuffer>;
  readonly uv: Float32Array<ArrayBuffer>;
  readonly index: Uint32Array<ArrayBuffer>;
  readonly matrix?: readonly number[];
  readonly skin?: BakedMeshSkin;
}

/**
 * A skinned mesh's skin: `skinIndex` and `skinWeight` (vec4 per vertex), the mesh's bind matrix,
 * the skeleton's bones, each bone's inverse bind matrix (`boneInverses`, {@link MATRIX_FLOATS}
 * floats per bone), and the animation clips of the bones.
 */
export interface BakedMeshSkin {
  readonly skinIndex: Float32Array<ArrayBuffer>;
  readonly skinWeight: Float32Array<ArrayBuffer>;
  readonly bindMatrix: readonly number[];
  readonly bones: readonly BakedBone[];
  readonly boneInverses: Float32Array<ArrayBuffer>;
  readonly clips: readonly BakedClip[];
}

/** Floats of a 4x4 matrix, column-major, as the skin stores one. */
export const MATRIX_FLOATS = 16;

/**
 * One bone: its name (what clips animate it by), its parent's index in `bones` (-1 for a root),
 * and its local matrix. A root's `parentMatrix` places its parent frame in the file's scene.
 */
export interface BakedBone {
  readonly name: string;
  readonly parent: number;
  readonly matrix: readonly number[];
  readonly parentMatrix?: readonly number[];
}

/** One animation clip of a skeleton's bones: its name, length in seconds and tracks. */
export interface BakedClip {
  readonly name: string;
  readonly duration: number;
  readonly tracks: readonly BakedTrack[];
}

/**
 * One keyframe track, as three's `KeyframeTrack`: `name` is `<bone>.<property>`, the property one
 * of those `meshGeometryBaking.ts` bakes (`position`, `quaternion`, `scale`), and the keys held
 * (`discrete`) or blended (`linear`) between.
 */
export interface BakedTrack {
  readonly name: string;
  readonly interpolation: "discrete" | "linear";
  readonly times: Float32Array<ArrayBuffer>;
  readonly values: Float32Array<ArrayBuffer>;
}

/**
 * A mesh asset baked from an uploaded GLB. A multi-mesh GLB gives one entry per mesh. `name` is the
 * key a `{ kind: "custom", meshAssetName }` geometry source references, `label` the original file
 * or mesh name, `byteSize` the upload size, shown in the content sheet only. A download regenerates
 * a GLB from `geometry`, not the original bytes.
 */
export interface MeshAsset {
  readonly name: string;
  readonly label: string;
  readonly geometry: BakedMeshGeometry;
  readonly byteSize: number;
  /** Drawn in the preview scene, where its file places it. Omitted when not. */
  readonly shownInScene?: true;
  /** The clip of a skinned mesh's skin the preview plays, by name; the first one when omitted. */
  readonly clip?: string;
}

/** The clip of `asset`'s skin the preview plays: the one it names, else the first, `undefined`
 *  without a skin or clips. */
export function previewClipOf(asset: MeshAsset): BakedClip | undefined {
  const clips = asset.geometry.skin?.clips ?? [];
  return clips.find((clip) => clip.name === asset.clip) ?? clips[0];
}

/**
 * One volume asset in the content library - an R8 3D texture baked from a mesh asset by the SDF
 * baker, a stand-in for the 3D texture the app supplies by `name`. `dataUrl` is a PNG atlas of its
 * slices (`domain/volumeAtlas.ts`), also what its download gives. `boxMin`/`boxMax` are the box its
 * texels fill, in the mesh's space, and a texel's byte `b` holds the distance `b / 255 * scale +
 * bias`: what an SDF Sample node picking it starts from.
 */
export interface VolumeAsset {
  readonly name: string;
  readonly label: string;
  readonly dataUrl: string;
  readonly size: readonly [number, number, number];
  readonly boxMin: readonly [number, number, number];
  readonly boxMax: readonly [number, number, number];
  readonly scale: number;
  readonly bias: number;
}

/** What a volume asset says about its texels, under the names of the SDF Sample inputs they set. */
export const VOLUME_DESCRIPTION_KEYS = [
  "boxMin",
  "boxMax",
  "scale",
  "bias",
] as const satisfies readonly (keyof VolumeAsset)[];

/** The authored document - the only thing persisted and versioned by history. */
export interface SourceState {
  /** The project's display name; the export filename derives from it, and it round-trips in the file. */
  readonly name: string;
  readonly scene: SceneModel;
  /** The texture library (raster images), addressable by Texture nodes. */
  readonly assets: readonly TextureAsset[];
  /** The HDRI environment library (hdr); listed in the content sheet, not node-referenced. */
  readonly environments: readonly EnvironmentAsset[];
  /** The `name` of the environment currently driving the viewport background/light probe, or
   *  `undefined` for manual Sun + Hemisphere lighting. */
  readonly activeEnvironmentName: string | undefined;
  /** The preview-scene library (GLB); listed in the content sheet, not node-referenced. */
  readonly scenes: readonly SceneAsset[];
  /** The scene drawn around the effect: a {@link BUILT_IN_SCENE_NAMES} entry or a `scenes` name. */
  readonly activeSceneName: string;
  /** The GLB mesh-asset library - geometries and surfaces nodes sample. */
  readonly meshAssets: readonly MeshAsset[];
  /** The volume-asset library - 3D textures baked from mesh assets, which nodes sample. */
  readonly volumeAssets: readonly VolumeAsset[];
  /** The saved-color palette, offered as quick picks by every color picker's palette panel (see
   *  `ui/components/paletteAccess.ts`); never node-referenced, and has no library screen of its
   *  own - the picker is the only place it is listed or managed. */
  readonly palette: readonly PaletteSwatch[];
  /** Scene-wide timeline settings (length); the per-emitter tracks live on each emitter. */
  readonly timeline: TimelineState;
}

/** The project name, or "Effect" when blank. */
export function projectDisplayName(name: string): string {
  const trimmed = name.trim();
  return trimmed === "" ? "Effect" : trimmed;
}

/** Outcome of the last live-apply, surfaced to the UI (e.g. to show errors). */
export interface LiveApplyStatus {
  readonly status: "recompiled" | "rebound" | "invalid";
  readonly messages: readonly string[];
  /**
   * The structured, node-attributed problems behind `messages`, when the failure is
   * attributable to specific nodes. Drives the canvas's per-node error highlight; empty
   * when the graph is valid or the failure has no node to blame (e.g. a graph blocked by
   * the *other* graph, or a codegen fault with no `nodeId`).
   */
  readonly errors?: readonly FXCompilerError[];
  /**
   * Problems that do not stop the graph from running here but may elsewhere or surprise its
   * author (a GPU tier's tighter limits, a mesh blind to its own transform) - shown apart from
   * `messages`, on a valid graph too.
   */
  readonly warnings?: readonly string[];
}

/** Everything computed from `source`; discarded and rebuilt, never persisted. */
export interface DerivedState {
  renderSnapshot?: FXGraphSnapshotData;
  behaviorSnapshot?: FXGraphSnapshotData;
  renderStatus?: LiveApplyStatus;
  behaviorStatus?: LiveApplyStatus;
  /** The active emitter's trail graph; both `undefined` when it has no trail - written every
   *  recompute, so a trail that went away (or another owner's) never lingers. */
  trailSnapshot?: FXGraphSnapshotData | undefined;
  trailStatus?: LiveApplyStatus | undefined;
  /** The active emitter's ribbon graph, as {@link trailSnapshot} for its trail. */
  ribbonSnapshot?: FXGraphSnapshotData | undefined;
  ribbonStatus?: LiveApplyStatus | undefined;
}

/** The whole editor state. */
export interface EditorState {
  source: SourceState;
  derived: DerivedState;
}

/** A fresh document's timeline settings: length in seconds and frame rate. */
export const DEFAULT_TIMELINE: TimelineState = { duration: 5, fps: 30, loop: true };

/** Assembles an authored graph from its authored nodes and bindings, then adds sinks. */
function buildGraph(
  kind: GraphKind,
  nodes: readonly GraphNode[],
  outputBindings: readonly GraphOutputBinding[],
  connections: readonly GraphConnection[] = [],
  host: RenderHost = DEFAULT_RENDER_HOST,
): EditorGraph {
  const base: EditorGraph = {
    ...createEmptyGraph(),
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    connections,
    outputBindings,
  };
  return ensureSinks(base, kind, host);
}

/**
 * A starter emitter with a visible effect: a lifetime and a sphere spawn volume on the behavior
 * sink, a constant color on albedo.
 */
export function createDefaultEmitter(id: string, name: string): EmitterDoc {
  const renderGraph = buildGraph(
    GraphKind.Render,
    [
      {
        id: "n_albedo",
        type: "constant",
        parameters: { type: "vec4", value: [0.55, 0.68, 0.95, 1] },
        position: { x: 168, y: 96 },
      },
      // A camera-facing rotation => particleTransform makes the default plane a billboard.
      // (The pipeline is geometry-agnostic; billboarding is an explicit node, not a builtin.)
      {
        id: "n_lookat",
        type: "look-at-camera",
        parameters: { roll: 0 },
        position: { x: 168, y: 264 },
      },
      {
        id: "n_transform",
        type: "compose-transform",
        parameters: { position: [0, 0, 0], scale: [1, 1, 1] },
        position: { x: 408, y: 264 },
      },
    ],
    [
      { slot: "albedo", from: { nodeId: "n_albedo", socketKey: "out" } },
      { slot: "particleTransform", from: { nodeId: "n_transform", socketKey: "out" } },
    ],
    [
      {
        id: "c_lookat_transform",
        from: { nodeId: "n_lookat", socketKey: "out" },
        to: { nodeId: "n_transform", socketKey: "rotation" },
      },
    ],
  );

  const behaviorGraph = buildGraph(
    GraphKind.Behavior,
    [
      {
        id: "n_pos",
        type: "random-sphere-point",
        parameters: { radius: 1.5, center: [0, 0, 0], surfaceOnly: false },
        position: { x: 168, y: 72 },
      },
      {
        id: "n_life",
        type: "lifetime",
        parameters: { min: 2, max: 2 },
        position: { x: 168, y: 264 },
      },
    ],
    [
      { slot: "lifetime", from: { nodeId: "n_life", socketKey: "value" }, phase: "spawn" },
      { slot: "position", from: { nodeId: "n_pos", socketKey: "position" }, phase: "spawn" },
    ],
  );

  return {
    id,
    name,
    renderGraph,
    behaviorGraph,
    tracks: [],
    // One default burst so a fresh document still shows particles the moment the timeline plays.
    events: [{ id: "event_1", kind: "burst", time: 0, count: 32 }],
    reactions: [],
    transform: IDENTITY_TRANSFORM,
    transformTracks: [],
    liveChannels: [],
    liveParams: [],
  };
}

/**
 * The trail graph an emitter starts with when its trail is turned on: a flat color on the surface
 * sink, the ribbon width and history left at the sink's defaults.
 */
export function createDefaultTrailGraph(): EditorGraph {
  return buildGraph(
    GraphKind.Render,
    [
      {
        id: "n_trail_albedo",
        type: "constant",
        parameters: { type: "vec4", value: [0.55, 0.68, 0.95, 0.6] },
        position: { x: 168, y: 96 },
      },
    ],
    [{ slot: "albedo", from: { nodeId: "n_trail_albedo", socketKey: "out" } }],
    [],
    "trail",
  );
}

/**
 * The ribbon graph an emitter starts with when its ribbon is turned on: a flat color on the
 * surface sink, the width and UV left at the sink's defaults.
 */
export function createDefaultRibbonGraph(): EditorGraph {
  return buildGraph(
    GraphKind.Render,
    [
      {
        id: "n_ribbon_albedo",
        type: "constant",
        parameters: { type: "vec4", value: [0.95, 0.68, 0.4, 0.6] },
        position: { x: 168, y: 96 },
      },
    ],
    [{ slot: "albedo", from: { nodeId: "n_ribbon_albedo", socketKey: "out" } }],
    [],
    "ribbon",
  );
}

/** A fresh VFX group: identity transform, no animation - the container every emitter sits under. */
export function createDefaultVfx(id: string): VfxDoc {
  return { id, transform: IDENTITY_TRANSFORM, transformTracks: [] };
}

/** An emitter with only the sink nodes, nothing wired and no events. */
export function createEmptyEmitter(id: string, name: string): EmitterDoc {
  return {
    id,
    name,
    renderGraph: buildGraph(GraphKind.Render, [], []),
    behaviorGraph: buildGraph(GraphKind.Behavior, [], []),
    tracks: [],
    events: [],
    reactions: [],
    transform: IDENTITY_TRANSFORM,
    transformTracks: [],
    liveChannels: [],
    liveParams: [],
  };
}

/** A starter mesh: a plane with a constant color on albedo, no behavior graph and no events. */
export function createDefaultVfxMesh(id: string, name: string): VfxMeshDoc {
  // A mesh material projects from the graph's transform outputs, never from the object's own
  // matrix, so the world matrix is wired in from the start: the mesh then follows its transform,
  // its keyframes and the effect's placement in the host scene.
  const renderGraph = buildGraph(
    GraphKind.Render,
    [
      {
        id: "n_albedo",
        type: "constant",
        parameters: { type: "vec4", value: [0.82, 0.82, 0.86, 1] },
        position: { x: 168, y: 120 },
      },
      {
        id: "n_world",
        type: "world-matrix",
        parameters: {},
        position: { x: 168, y: 312 },
      },
    ],
    [
      { slot: "albedo", from: { nodeId: "n_albedo", socketKey: "out" } },
      { slot: "vertexTransform", from: { nodeId: "n_world", socketKey: "out" } },
    ],
  );
  return {
    id,
    name,
    renderGraph,
    tracks: [],
    transform: IDENTITY_TRANSFORM,
    transformTracks: [],
    liveChannels: [],
    liveParams: [],
  };
}

/** A blank document: a VFX group holding one empty emitter, which is the active one. No meshes. */
export function createInitialState(): EditorState {
  const emitter = createEmptyEmitter("emitter_1", "Emitter");
  return {
    source: {
      name: "",
      scene: {
        vfx: createDefaultVfx("vfx_1"),
        emitters: [emitter],
        activeEmitterId: emitter.id,
        meshes: [],
        activeGraphKind: "emitter",
      },
      assets: [],
      environments: [],
      activeEnvironmentName: undefined,
      scenes: [],
      activeSceneName: STUDIO_SCENE_NAME,
      meshAssets: [],
      volumeAssets: [],
      palette: [],
      timeline: DEFAULT_TIMELINE,
    },
    derived: {},
  };
}
