/**
 * The reserved sink nodes (behavior's `$spawn`/`$update`, render's `$out`): their identity, the
 * render sink's render-mode/geometry value domain, and how each sink's `FXNodeMeta` is derived from
 * the engine's own targets - so the editor's sink sockets/params never drift from what the engine
 * actually accepts.
 */

import {
  attributeSlot,
  buildParticleBehaviorTargets,
} from "../engine/behavior/FXParticleBehaviorTarget";
import type { FXNodeMeta, FXParamMeta, FXSocketMeta } from "../engine/core/nodes/FXSocketSpec";
import {
  buildParticleTarget,
  FX_MESH_TARGET,
} from "../engine/render/target/FXParticleRenderTarget";
import type { FXGeometrySource, FXRenderMode } from "sparcoon";
import type { EditorAttribute, EditorGraph } from "./graphModel";

/**
 * The reserved output **sink** nodes: permanent, non-addable, non-deletable terminus nodes.
 * Wiring into a sink's input authors an {@link EditorGraph.outputBindings} entry; `serialize.ts`
 * drops the sinks since the target's output slots *are* the inputs. Behavior carries two (`spawn`/
 * `update`, so the write phase is chosen by wiring); render carries one, the surface `$out`.
 */
export const SPAWN_SINK_TYPE = "$spawn";
export const UPDATE_SINK_TYPE = "$update";
export const RENDER_SINK_TYPE = "$out";

/** Reserved node ids the sinks occupy (spawn + update on behavior; surface on render). */
export const SPAWN_SINK_ID = "out:spawn";
export const UPDATE_SINK_ID = "out:update";
export const RENDER_SINK_ID = "out";

const SINK_TYPES: ReadonlySet<string> = new Set([
  SPAWN_SINK_TYPE,
  UPDATE_SINK_TYPE,
  RENDER_SINK_TYPE,
]);

export function isSinkType(type: string): boolean {
  return SINK_TYPES.has(type);
}

/** The behavior phase a sink writes in, or `undefined` for the render sink. */
export function sinkPhase(type: string): "spawn" | "update" | undefined {
  if (type === SPAWN_SINK_TYPE) {
    return "spawn";
  }
  if (type === UPDATE_SINK_TYPE) {
    return "update";
  }
  return undefined;
}

/**
 * Which render entity a render graph drives. A `"mesh"` has no `particleTransform` slot or
 * `sortInterval` parameter (posed by its own scene transform, no runtime emitter).
 */
export type RenderHost = "particle" | "mesh";
export const DEFAULT_RENDER_HOST: RenderHost = "particle";

/** How the surface sink composites the fragment's alpha (see the runtime `FXRenderMode`). */
export type RenderMode = FXRenderMode;
const RENDER_MODE_OPTIONS: readonly RenderMode[] = ["blending", "alphaHash", "alphaTest", "opaque"];
export const DEFAULT_RENDER_MODE: RenderMode = "blending";

/** Normalizes an unknown `renderMode` parameter value to a known mode. */
export function coerceRenderMode(value: unknown): RenderMode {
  return (RENDER_MODE_OPTIONS as readonly string[]).includes(value as string)
    ? (value as RenderMode)
    : DEFAULT_RENDER_MODE;
}

/** Built-in per-particle geometry primitives - a plane is the billboard default. */
export type GeometryKind = "plane" | "box" | "sphere";
const GEOMETRY_OPTIONS: readonly GeometryKind[] = ["plane", "box", "sphere"];
export const DEFAULT_GEOMETRY: GeometryKind = "plane";

/** Normalizes an unknown `geometry` parameter value to a known primitive (a `"mesh:"`-prefixed custom
 *  choice - see {@link coerceGeometrySource} - falls through to the primitive default here). */
export function coerceGeometry(value: unknown): GeometryKind {
  return value === "box" || value === "sphere" ? value : "plane";
}

/** The discriminated choice an emitter's or VFX mesh's geometry resolves to: a built-in
 *  primitive, or a custom mesh asset from the content library. */
export type GeometrySource =
  | { readonly kind: "primitive"; readonly primitive: GeometryKind }
  | { readonly kind: "custom"; readonly meshAssetName: string };

/** The `geometry` parameter's stored-value prefix for a custom mesh-asset choice, e.g. `"mesh:wheel"` -
 *  disambiguates a mesh asset from a built-in primitive in the single structural string. */
const CUSTOM_GEOMETRY_PREFIX = "mesh:";

/** Encodes a {@link GeometrySource} back into the `geometry` parameter's stored string value. */
export function encodeGeometrySource(source: GeometrySource): string {
  return source.kind === "primitive"
    ? source.primitive
    : CUSTOM_GEOMETRY_PREFIX + source.meshAssetName;
}

/** Normalizes an unknown `geometry` parameter value to a {@link GeometrySource}: a `"mesh:<name>"`
 *  value is a custom mesh-asset reference (need not still exist); anything else is a primitive. */
export function coerceGeometrySource(value: unknown): GeometrySource {
  if (typeof value === "string" && value.startsWith(CUSTOM_GEOMETRY_PREFIX)) {
    return { kind: "custom", meshAssetName: value.slice(CUSTOM_GEOMETRY_PREFIX.length) };
  }
  return { kind: "primitive", primitive: coerceGeometry(value) };
}

/** Translates a {@link GeometrySource} into the runtime artifact's external-slot shape (ADR-0002):
 *  a custom mesh asset crosses the compile boundary named, not embedded. */
export function toArtifactGeometrySource(source: GeometrySource): FXGeometrySource {
  return source.kind === "primitive"
    ? { type: "primitive", primitive: source.primitive }
    : { type: "custom", external: source.meshAssetName };
}

function slotSocket(output: {
  slot: string;
  type: { glslTypeName: FXSocketMeta["type"] };
  required: boolean;
}): FXSocketMeta {
  return {
    key: output.slot,
    type: output.type.glslTypeName,
    required: output.required,
  };
}

/** Picks the named target output slots (in the given order), skipping any absent. */
function builtinSockets(
  outputs: readonly {
    slot: string;
    type: { glslTypeName: FXSocketMeta["type"] };
    required: boolean;
  }[],
  names: readonly string[],
): readonly FXSocketMeta[] {
  const byName = new Map(outputs.map((output) => [output.slot, output]));
  return names.flatMap((name) => {
    const output = byName.get(name);
    return output === undefined ? [] : [slotSocket(output)];
  });
}

// Behavior sink builtins: the whole `position` vec3 (not per-axis slots), plus the birth-only
// `lifetime` at spawn only. Types come from the engine target so they never drift.
const behaviorTargets = buildParticleBehaviorTargets();
const SPAWN_SINK_BUILTINS: readonly FXSocketMeta[] = builtinSockets(behaviorTargets.spawn.outputs, [
  "position",
  "lifetime",
]);
const UPDATE_SINK_BUILTINS: readonly FXSocketMeta[] = builtinSockets(
  behaviorTargets.update.outputs,
  ["position"],
);
/** Whether the surface sink shows a slot in a render mode: `additivity` only when blending, the
 *  `alphaThreshold` cutoff in every mode but opaque, `albedo` + transforms always. */
function showsSurfaceSlot(slot: string, renderMode: RenderMode): boolean {
  if (slot === "additivity") {
    return renderMode === "blending";
  }
  if (slot === "alphaThreshold") {
    return renderMode !== "opaque";
  }
  return true;
}

/** The surface (`$out`) input sockets for a render mode and host - the host's target output
 *  slots gated by the mode. A `"mesh"` host draws from {@link FX_MESH_TARGET}. */
function renderSinkInputsFor(renderMode: RenderMode, host: RenderHost): readonly FXSocketMeta[] {
  const target = host === "mesh" ? FX_MESH_TARGET : buildParticleTarget();
  return target.outputs
    .filter((output) => showsSurfaceSlot(output.slot, renderMode))
    .map(slotSocket);
}

function attributeSocket(attribute: EditorAttribute): FXSocketMeta {
  return { key: attributeSlot(attribute.name), type: attribute.type, label: attribute.name };
}

/** The render sink's geometry selector: a built-in primitive, or (appended when the content
 *  library has any) a `"mesh:<name>"` custom mesh asset - see {@link coerceGeometrySource}. */
function geometryParam(meshAssetNames: readonly string[]): FXParamMeta {
  return {
    kind: "structural",
    type: "enum",
    options: [
      ...GEOMETRY_OPTIONS,
      ...meshAssetNames.map((name) => CUSTOM_GEOMETRY_PREFIX + name),
    ] as string[],
    default: DEFAULT_GEOMETRY,
  };
}

/** The surface sink's render-mode selector: how the fragment's alpha composites into the
 *  framebuffer. Structural - reshapes which surface sockets show, so a change rebuilds. */
const RENDER_MODE_PARAM: FXParamMeta = {
  kind: "structural",
  type: "enum",
  options: RENDER_MODE_OPTIONS,
  default: DEFAULT_RENDER_MODE,
};

/** The surface sink parameter key carrying the render mode (read into the compile options). */
export const RENDER_MODE_PARAM_KEY = "renderMode";

/** The render sink's camera depth-sort interval (frames, `0` = off). A runtime emitter setting,
 *  not a compile input - the preview maps it to `FXEmitter.sortCamera`/`sortFraction = 1/N`. */
const SORT_INTERVAL_PARAM: FXParamMeta = {
  kind: "value",
  type: "float",
  default: 0,
  min: 0,
  step: 1,
};

/** The render sink parameter key carrying the camera depth-sort interval (frames; 0 = off). */
export const RENDER_SORT_INTERVAL_PARAM = "sortInterval";

/** The render sink's sort interval as a non-negative whole number of frames (0 = no sorting). */
export function coerceSortInterval(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

/** The render sink's cast-shadow flag: builds a customDepthMaterial from this render graph so the
 *  shadow silhouette honors the authored shape/alpha. A runtime setting, not a compile input. */
const CAST_SHADOW_PARAM: FXParamMeta = {
  kind: "structural",
  type: "flag",
  default: false,
};

/** The surface sink parameter key carrying the cast-shadow flag. */
export const RENDER_CAST_SHADOW_PARAM = "castShadow";

/** The render sink's receive-shadow flag: lets scene lights shadow this surface (visible only on a
 *  lit graph - an unlit surface has no light chain to be shadowed). Read like {@link CAST_SHADOW_PARAM}. */
const RECEIVE_SHADOW_PARAM: FXParamMeta = {
  kind: "structural",
  type: "flag",
  default: false,
};

/** The surface sink parameter key carrying the receive-shadow flag. */
export const RENDER_RECEIVE_SHADOW_PARAM = "receiveShadow";

/**
 * The spawn sink's "Try GPU simulation" flag: a best-effort request to also compile this
 * emitter's behavior graph to the standard-tier (WebGL2, transform-feedback) GLSL kernel. Named
 * "try" since it is never a guarantee - a JS-only construct silently degrades that emitter to
 * JS-only, and even a compiled GPU artifact only runs on a "standard" live tier. Defaults on (see
 * {@link readSpawnSinkConfig}'s `!== false` read).
 */
const TRY_GPU_SIMULATION_PARAM: FXParamMeta = {
  kind: "structural",
  type: "flag",
  default: true,
};

/** The spawn sink parameter key carrying the "Try GPU simulation" flag. */
export const SPAWN_TRY_GPU_SIMULATION_PARAM = "tryGpuSimulation";

/** The default expected-particle-count every new emitter starts with (see {@link
 *  EXPECTED_CAPACITY_PARAM}); matches the runtime's own historical author-facing default. */
const DEFAULT_EXPECTED_CAPACITY = 256;

/**
 * The spawn sink's expected-particle-count: sizes this emitter's state buffers at build time - a
 * starting size that grows on demand (`capacityStep`) for a JS-driven emitter, but a fixed hard
 * ceiling for a GPU-driven one (see {@link TRY_GPU_SIMULATION_PARAM}), which has no growth path.
 *
 * `kind: "value"` only because {@link FXParamSpec} has no structural numeric variant; sink params
 * never reach the engine's structural-hash gate anyway, so EmitterView's own rebuild tracking is
 * what actually forces a rebuild here, the same way it does for castShadow/receiveShadow.
 */
const EXPECTED_CAPACITY_PARAM: FXParamMeta = {
  kind: "value",
  type: "float",
  default: DEFAULT_EXPECTED_CAPACITY,
  min: 1,
  step: 1,
};

/** The spawn sink parameter key carrying the expected-particle-count. */
export const SPAWN_EXPECTED_CAPACITY_PARAM = "expectedCapacity";

/** A positive whole particle count, defaulting on anything else (missing, fractional, <= 0). */
function coerceExpectedCapacity(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : DEFAULT_EXPECTED_CAPACITY;
}

/** The spawn graph's runtime config: the GPU-simulation opt-in and the emitter's buffer capacity. */
export interface SpawnSinkConfig {
  readonly tryGpuSimulation: boolean;
  readonly expectedCapacity: number;
}

/** Reads a behavior graph's spawn-sink parameters into a {@link SpawnSinkConfig}; a missing/blank
 *  node falls back to each parameter's default. `tryGpuSimulation` defaults on - reserved sinks
 *  are created with an empty `parameters` bag (`sinks.ts`'s `makeSink`), so `!== false` (not
 *  `=== true`) is what actually encodes that default; only an explicit `false` turns it off. */
export function readSpawnSinkConfig(behaviorGraph: EditorGraph): SpawnSinkConfig {
  const spawn = behaviorGraph.nodes[SPAWN_SINK_ID]?.parameters;
  return {
    tryGpuSimulation: spawn?.[SPAWN_TRY_GPU_SIMULATION_PARAM] !== false,
    expectedCapacity: coerceExpectedCapacity(spawn?.[SPAWN_EXPECTED_CAPACITY_PARAM]),
  };
}

/** The render graph's runtime config: geometry source, render mode, sort toggle, and shadow flags. */
export interface RenderSinkConfig {
  readonly geometry: GeometrySource;
  readonly renderMode: RenderMode;
  readonly sortInterval: number;
  readonly castShadow: boolean;
  readonly receiveShadow: boolean;
}

/** Reads a render graph's reserved-node parameters into a {@link RenderSinkConfig}; a
 *  missing/blank node falls back to every parameter's default. */
export function readRenderSinkConfig(renderGraph: EditorGraph): RenderSinkConfig {
  const surface = renderGraph.nodes[RENDER_SINK_ID]?.parameters;
  return {
    geometry: coerceGeometrySource(surface?.["geometry"]),
    renderMode: coerceRenderMode(surface?.[RENDER_MODE_PARAM_KEY]),
    sortInterval: coerceSortInterval(surface?.[RENDER_SORT_INTERVAL_PARAM]),
    castShadow: surface?.[RENDER_CAST_SHADOW_PARAM] === true,
    receiveShadow: surface?.[RENDER_RECEIVE_SHADOW_PARAM] === true,
  };
}

/**
 * Metadata for a reserved sink: inputs are the target's output slots, no outputs. Not in
 * `NODE_PALETTE`; resolved by `metaForNode` so the canvas renders a sink like any node.
 */
export interface SinkMetaOptions {
  /** Surface sink only: the render mode, which gates the additivity / alphaThreshold sockets. */
  readonly renderMode?: RenderMode;
  /** Surface sink only: which render entity, gating the `particleTransform` slot and `sortInterval`
   *  parameter. @defaultValue `"particle"` */
  readonly renderHost?: RenderHost;
  /** Behavior sinks only: the graph's declared attributes, appended as `attr:<name>` slots. */
  readonly attributes?: readonly EditorAttribute[];
  /** Surface sink only: the content library's current mesh asset names, appended to the Geometry
   *  parameter's options as `"mesh:<name>"` choices. @defaultValue `[]` */
  readonly meshAssetNames?: readonly string[];
}

export function sinkMeta(type: string, options: SinkMetaOptions = {}): FXNodeMeta {
  const attributeSockets = (options.attributes ?? []).map(attributeSocket);
  if (type === SPAWN_SINK_TYPE) {
    return {
      type,
      category: "spawn",
      domain: "behavior",
      inputs: [...SPAWN_SINK_BUILTINS, ...attributeSockets],
      outputs: [],
      params: {
        [SPAWN_TRY_GPU_SIMULATION_PARAM]: TRY_GPU_SIMULATION_PARAM,
        [SPAWN_EXPECTED_CAPACITY_PARAM]: EXPECTED_CAPACITY_PARAM,
      },
      reads: [],
    };
  }
  if (type === UPDATE_SINK_TYPE) {
    return {
      type,
      category: "spawn",
      domain: "behavior",
      inputs: [...UPDATE_SINK_BUILTINS, ...attributeSockets],
      outputs: [],
      params: {},
      reads: [],
    };
  }
  const host = options.renderHost ?? DEFAULT_RENDER_HOST;
  const isMesh = host === "mesh";
  const geometry = geometryParam(options.meshAssetNames ?? []);
  return {
    type: RENDER_SINK_TYPE,
    category: "source",
    domain: "render",
    inputs: renderSinkInputsFor(options.renderMode ?? DEFAULT_RENDER_MODE, host),
    outputs: [],
    // A mesh has no runtime emitter, so no camera depth-sort parameter. Both hosts carry the shadow flags.
    params: isMesh
      ? {
          [RENDER_MODE_PARAM_KEY]: RENDER_MODE_PARAM,
          geometry,
          [RENDER_CAST_SHADOW_PARAM]: CAST_SHADOW_PARAM,
          [RENDER_RECEIVE_SHADOW_PARAM]: RECEIVE_SHADOW_PARAM,
        }
      : {
          [RENDER_MODE_PARAM_KEY]: RENDER_MODE_PARAM,
          geometry,
          [RENDER_SORT_INTERVAL_PARAM]: SORT_INTERVAL_PARAM,
          [RENDER_CAST_SHADOW_PARAM]: CAST_SHADOW_PARAM,
          [RENDER_RECEIVE_SHADOW_PARAM]: RECEIVE_SHADOW_PARAM,
        },
    reads: [],
  };
}
