/**
 * The single state object, split exactly along the source / derived boundary.
 *
 * - `source` is everything the user authored: it is saved, and only it enters the
 *   undo history.
 * - `derived` is everything computed from `source`: never saved, never in history,
 *   recomputed by the pipeline on every structural edit.
 */

import type { FXGraphSnapshotData } from "../engine/core/live/FXSnapshotData";
import type { FXCompilerError } from "../engine/core/compiler/FXCompilerError";
import type {
  EditorGraph,
  GraphConnection,
  GraphNode,
  GraphOutputBinding,
} from "../domain/graphModel";
import { createEmptyGraph } from "../domain/graphModel";
import { GraphKind } from "../domain/nodePalette";
import { ensureSinks } from "../domain/sinks";
import {
  IDENTITY_TRANSFORM,
  type Transform,
  type TransformChannel,
  type TransformTrack,
} from "./transform";

/** Emitter-level settings the user authors (spawn rate, ...). Expected capacity lives on the
 *  spawn sink instead (domain/sinkMeta.ts's SpawnSinkConfig) - it is structural (a buffer resize),
 *  unlike this record's fields. */
export interface EmitterSettings {
  readonly spawnRate: number;
}

/** One baked keyframe: a Timeline Value's value at a point in time (seconds on the timeline). */
export interface Keyframe {
  /** Stable id, so the timeline can select, move and inspect a key across edits. */
  readonly id: string;
  readonly time: number;
  readonly value: number | readonly number[];
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
 * A timeline **spawn event** on one emitter, fired as the playhead crosses `time`. `burst`
 * spawns `count` particles at once; `play` emits at `rate` particles/second for `duration`
 * seconds. Events carry an `id` so they can be retimed and edited in place, and are the only
 * thing that makes an emitter spawn - a fresh emitter is idle until an event fires.
 */
export interface BurstEvent {
  readonly id: string;
  readonly kind: "burst";
  readonly time: number;
  readonly count: number;
}

export interface PlayEvent {
  readonly id: string;
  readonly kind: "play";
  readonly time: number;
  readonly rate: number;
  /** Emission length in seconds. */
  readonly duration: number;
}

export type TimelineEvent = BurstEvent | PlayEvent;

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
  readonly settings: EmitterSettings;
  /** This emitter's animation tracks (one per animated Timeline Value); the timeline shows them. */
  readonly tracks: readonly AnimationTrack[];
  /** This emitter's timeline spawn events (burst / play), sorted by time; the timeline drives them. */
  readonly events: readonly TimelineEvent[];
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
  /** Hidden in the preview + outline. Editor-only - never affects the TS export. */
  readonly hidden?: boolean;
}

/**
 * The **VFX** entity: the single group that owns every emitter in the scene. It carries
 * its own transform + transform tracks so the whole effect can be posed and animated as one unit,
 * and appears in the timeline as the top entity above the emitters.
 *
 * Unlike an emitter/mesh, the VFX group has no `liveChannels` field: all three of its transform
 * channels are unconditionally live (`entity.kind === "vfx"` is special-cased wherever that
 * matters - transformCommands.ts's `setLiveChannel`, exportTypeScript.ts's root specification literal) -
 * the root transform is exclusively the TypeScript export's consumer to place in their scene, and
 * that can never be toggled off, so there is nothing to store.
 *
 * No `name` field either: the root has no identity of its own to name - it displays and edits the
 * project's own name (`SourceState.name`, via `projectDisplayName`) everywhere it would otherwise
 * show one (the outliner, the viewport Item tab), so there is exactly one name to keep in sync
 * instead of two.
 */
export interface VfxDoc {
  readonly id: string;
  readonly transform: Transform;
  readonly transformTracks: readonly TransformTrack[];
}

/**
 * One **VFX mesh** in the scene: a single, non-instanced mesh with a render graph (its material) but
 * NO simulation - no behavior graph, no per-particle attributes, no spawn settings, no spawn events.
 * It renders one primitive (chosen by the surface sink's Geometry param, unified with emitters), is
 * posed/animated by its transform like an emitter, and may animate its render-graph params through
 * `tracks`. A distinct scene object, not an emitter.
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
  readonly activeEmitterId: string;
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
 * stale). `undefined` only when the scene has no emitters. The single resolver every read (selectors)
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
  return emitterId !== undefined ? { kind: "emitter", id: emitterId } : undefined;
}

/** Scene-wide timeline settings (authored). One shared playhead runs over `[0, duration)`. */
export interface TimelineState {
  /** Total timeline length in seconds; playback loops back to 0 at the end. */
  readonly duration: number;
  /** Frame rate: the caret, keyframes and events snap to this frame grid (frames/second). */
  readonly fps: number;
}

/**
 * One raster-image asset in the library. `name` is a valid param identifier
 * (`^[a-z][A-Za-z0-9]*`, unique) - it is what a Texture node references and what
 * derives its uniform slot `u_param_<name>`. `label` keeps the original file name for
 * display, and `dataUrl` is the base64-encoded image (persisted with the document).
 */
export interface TextureAsset {
  readonly name: string;
  readonly label: string;
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
}

/**
 * One HDRI environment asset (hdr) in the content library, selectable in the Lighting tab as the
 * viewport's active background and light source (ADR-0004). `name` is only a unique key (not a
 * param identifier - no node references it). `label` keeps the original file name for display and
 * download, `dataUrl` is the base64-encoded file, and `byteSize` is its decoded size.
 */
export interface EnvironmentAsset {
  readonly name: string;
  readonly label: string;
  readonly dataUrl: string;
  readonly byteSize: number;
}

/**
 * One mesh's baked geometry (see ADR-0001): flat per-vertex `position`/`normal` (vec3) and `uv`
 * (vec2) arrays plus a triangle `index` array - the same subset {@link buildPrimitiveGeometry}
 * produces for the built-in primitives (no tangents/vertex-colors/extra UV sets/skinning). Plain
 * number arrays, not a base64 blob: this data is already the semantic source of truth (the
 * uploaded GLB's bytes are not retained), so there is nothing left to encode.
 */
export interface BakedMeshGeometry {
  readonly position: readonly number[];
  readonly normal: readonly number[];
  readonly uv: readonly number[];
  readonly index: readonly number[];
}

/**
 * One mesh asset in the content library, baked from an uploaded GLB at upload time (ADR-0001). A
 * multi-mesh GLB decomposes into several independent entries, one per mesh (ADR-0003). `name` is a
 * unique key referenced by a `{ kind: "custom", meshAssetName }` geometry source; `label` is the
 * original file/mesh name for display; `byteSize` is the original upload's size, kept only for the
 * content sheet's row display (not a round-trip guarantee - see ADR-0001 on the download regenerating
 * a GLB from `geometry`, not returning the original bytes).
 */
export interface MeshAsset {
  readonly name: string;
  readonly label: string;
  readonly geometry: BakedMeshGeometry;
  readonly byteSize: number;
}

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
  /** The GLB mesh-asset library; listed in the content sheet, not node-referenced yet. */
  readonly meshAssets: readonly MeshAsset[];
  /** Scene-wide timeline settings (length); the per-emitter tracks live on each emitter. */
  readonly timeline: TimelineState;
}

/**
 * `SourceState.name`, falling back to "Effect" when unset (blank/whitespace) - the single display
 * name shown everywhere the project's identity appears (the outliner's root row, the viewport
 * Item tab, the exported class name before `exportTypeScript.ts`'s `classNameFor` PascalCases it),
 * so a fresh, never-renamed project still reads as something instead of blank.
 */
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
}

/** Everything computed from `source`; discarded and rebuilt, never persisted. */
export interface DerivedState {
  renderSnapshot?: FXGraphSnapshotData;
  behaviorSnapshot?: FXGraphSnapshotData;
  renderStatus?: LiveApplyStatus;
  behaviorStatus?: LiveApplyStatus;
}

/** The whole editor state. */
export interface EditorState {
  source: SourceState;
  derived: DerivedState;
}

/** A fresh emitter's settings; also the fallback when a persisted emitter's settings are corrupt. */
export const DEFAULT_EMITTER_SETTINGS: EmitterSettings = { spawnRate: 20 };

/** A fresh document's timeline settings: length in seconds and frame rate. */
export const DEFAULT_TIMELINE: TimelineState = { duration: 5, fps: 30 };

/** Assembles an authored graph from its authored nodes and bindings, then adds sinks. */
function buildGraph(
  kind: GraphKind,
  nodes: readonly GraphNode[],
  outputBindings: readonly GraphOutputBinding[],
  connections: readonly GraphConnection[] = [],
): EditorGraph {
  const base: EditorGraph = {
    ...createEmptyGraph(),
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    connections,
    outputBindings,
  };
  return ensureSinks(base, kind);
}

/**
 * A starter emitter with a minimal **visible** effect: a lifetime + a sphere spawn
 * volume feed the behavior sink (particles that live and fill a cloud), and a constant
 * color feeds the render sink's albedo. So a newly added emitter already shows something in
 * the preview, demonstrating that each emitter's graphs drive its own runtime emitter.
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
        type: "spawn-sphere",
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
    settings: DEFAULT_EMITTER_SETTINGS,
    tracks: [],
    // One default burst so a fresh document still shows particles the moment the timeline plays.
    events: [{ id: "event_1", kind: "burst", time: 0, count: 32 }],
    transform: IDENTITY_TRANSFORM,
    transformTracks: [],
    liveChannels: [],
    liveParams: [],
  };
}

/** A fresh VFX group: identity transform, no animation - the container every emitter sits under. */
export function createDefaultVfx(id: string): VfxDoc {
  return { id, transform: IDENTITY_TRANSFORM, transformTracks: [] };
}

/** A genuinely blank emitter: only the mandatory sink nodes `buildGraph` adds, nothing wired to
 *  them, no events - the "Empty" preset's basis, distinct from {@link createDefaultEmitter}'s
 *  visible starter (still used by "Add Emitter"). */
export function createEmptyEmitter(id: string, name: string): EmitterDoc {
  return {
    id,
    name,
    renderGraph: buildGraph(GraphKind.Render, [], []),
    behaviorGraph: buildGraph(GraphKind.Behavior, [], []),
    settings: DEFAULT_EMITTER_SETTINGS,
    tracks: [],
    events: [],
    transform: IDENTITY_TRANSFORM,
    transformTracks: [],
    liveChannels: [],
    liveParams: [],
  };
}

/**
 * A starter VFX mesh: a plane rendered with a minimal visible material (a constant color feeding the
 * render sink's albedo). No behavior graph, no events - a mesh is a plain, un-simulated object posed
 * by its transform.
 */
export function createDefaultVfxMesh(id: string, name: string): VfxMeshDoc {
  const renderGraph = buildGraph(
    GraphKind.Render,
    [
      {
        id: "n_albedo",
        type: "constant",
        parameters: { type: "vec4", value: [0.82, 0.82, 0.86, 1] },
        position: { x: 168, y: 120 },
      },
    ],
    [{ slot: "albedo", from: { nodeId: "n_albedo", socketKey: "out" } }],
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
      meshAssets: [],
      timeline: DEFAULT_TIMELINE,
    },
    derived: {},
  };
}
