/**
 * The node palette, derived from the engine's node metadata. A node type is not unique across
 * domains (`life-ratio`), so nodes are bucketed by graph kind (render, behavior, shared).
 */

import type { FXCompilerError } from "../engine/core/compiler/FXCompilerError";
import type { FXNodeMeta, FXSocketMeta } from "../engine/core/nodes/FXSocketSpec";
import { FX_READABLE_CORE_BUILTINS } from "../engine/core/socket/FXReadableBuiltins";
import { FX_STANDARD_NODES } from "../engine/nodes-std/index";
import { FX_MANUAL_NODE_METAS } from "../engine/nodes-std/manualNodeMetas";
import { coerceParamValue, resolveParamType } from "../engine/nodes-std/paramSupport.Internal";
import {
  buildParticleTarget,
  FX_MESH_TARGET,
  FX_TRAIL_TARGET,
} from "../engine/render/target/FXParticleRenderTarget";
import { ROUTE_TYPE, routeMeta } from "./fakeNodes";
import type { AttributeTypeName, EditorAttribute, EditorGraph, GraphNode } from "./graphModel";
import {
  coerceRenderMode,
  DEFAULT_RENDER_HOST,
  isSinkType,
  type RenderHost,
  sinkMeta,
} from "./sinkMeta";

export type { FXNodeMeta, FXParamMeta, FXSocketMeta } from "../engine/core/nodes/FXSocketSpec";
export {
  coerceGeometry,
  coerceGeometrySource,
  coerceRenderMode,
  coerceSortInterval,
  DEFAULT_GEOMETRY,
  DEFAULT_RENDER_HOST,
  DEFAULT_RENDER_MODE,
  encodeGeometrySource,
  type GeometryKind,
  type GeometrySource,
  isSinkType,
  isStripHost,
  readRenderSinkConfig,
  readRibbonSinkConfig,
  readSpawnSinkConfig,
  readStripSinkConfig,
  readTrailSinkConfig,
  RENDER_CAST_SHADOW_PARAM,
  RENDER_DRAW_PARTICLES_PARAM,
  RENDER_MODE_PARAM_KEY,
  RENDER_RECEIVE_SHADOW_PARAM,
  RENDER_SINK_ID,
  RENDER_SINK_TYPE,
  RENDER_SORT_INTERVAL_PARAM,
  type RenderHost,
  type RenderMode,
  type RenderSinkConfig,
  RIBBON_HEAD_PARAM_KEY,
  RIBBON_SECTION_PARAM_KEY,
  RIBBON_TILE_PARAM_KEY,
  RIBBON_UV_PARAM_KEY,
  type RibbonSinkConfig,
  type RibbonUVMode,
  sinkMeta,
  type SinkMetaOptions,
  sinkPhase,
  SPAWN_EXPECTED_CAPACITY_PARAM,
  SPAWN_SINK_ID,
  SPAWN_SINK_TYPE,
  SPAWN_TRY_GPU_SIMULATION_PARAM,
  type SpawnSinkConfig,
  STRIP_HOSTS,
  type StripHost,
  type StripRuntimeFields,
  stripRuntimeFields,
  type StripSinkConfigs,
  toArtifactGeometrySource,
  TRAIL_FRAMES_PARAM_KEY,
  TRAIL_INTERVAL_PARAM_KEY,
  type TrailSinkConfig,
  UPDATE_SINK_ID,
  UPDATE_SINK_TYPE,
} from "./sinkMeta";

/** Which authored graph a node belongs to. Maps to the engine node `domain`. */
export enum GraphKind {
  Render = "render",
  Behavior = "behavior",
}

/** The timeline-value node - a named, runtime-tunable uniform input, drawn with a distinct accent. */
export const TIMELINE_VALUE_TYPE = "timeline-value";

/**
 * Whether a node type gets the timeline-value accent. The `texture` node is also a runtime input
 * but has its own preview and is not tinted.
 */
export function isTimelineValueType(type: string): boolean {
  return type === TIMELINE_VALUE_TYPE;
}

/**
 * The `timeline-value` node declaring each parameter name across `graphs` - the first one, in
 * graph order, where several share a name.
 */
export function timelineValueDeclarations(
  graphs: readonly EditorGraph[],
): ReadonlyMap<string, GraphNode> {
  const declarations = new Map<string, GraphNode>();
  for (const graph of graphs) {
    for (const node of Object.values(graph.nodes)) {
      const name = node.parameters["name"];
      if (
        node.type === TIMELINE_VALUE_TYPE &&
        typeof name === "string" &&
        !declarations.has(name)
      ) {
        declarations.set(name, node);
      }
    }
  }
  return declarations;
}

/** A Timeline Value declared unlike the first declaration of its name. */
export interface TimelineValueConflict {
  /** Index into the `graphs` passed in: the graph holding the conflicting node. */
  readonly graphIndex: number;
  readonly error: FXCompilerError;
}

/** A Timeline Value's declared type and default, as the engine reads them. */
interface TimelineValueShape {
  /** The type's GLSL name - a color is the vec4 it is. */
  readonly type: string;
  /** The default at the type's width (see `coerceParamValue`); `undefined` when the type or the
   *  value is malformed - the node's own compile reports that. */
  readonly value: readonly number[] | undefined;
}

/** Reads `node`'s type and default the way the engine's `timeline-value` factory does: an unset
 *  type is a float and an unset value 0, padded or truncated to the type's width. */
function timelineValueShape(node: GraphNode): TimelineValueShape {
  const rawType = node.parameters["type"] ?? "float";
  // A color is a vec4 uniform: the two declare the same value.
  const type = rawType === "color" ? "vec4" : typeof rawType === "string" ? rawType : "float";
  try {
    const coerced = coerceParamValue(
      resolveParamType(rawType).components,
      node.parameters["value"] ?? 0,
    );
    return { type, value: typeof coerced === "number" ? [coerced] : coerced };
  } catch {
    return { type, value: undefined };
  }
}

/**
 * Every `timeline-value` node whose type or default differs from the first declaration of its name,
 * in graph then node order, reported on the disagreeing node. A name is one track and one
 * `setEmitterParam`, so all declarations must agree. Defaults compare as the engine reads them (see
 * {@link timelineValueShape}), so scalar `0` equals `[0, 0, 0]`.
 */
export function timelineValueConflicts(
  graphs: readonly EditorGraph[],
): readonly TimelineValueConflict[] {
  const first = new Map<string, TimelineValueShape>();
  const conflicts: TimelineValueConflict[] = [];
  graphs.forEach((graph, graphIndex) => {
    for (const node of Object.values(graph.nodes)) {
      const name = node.parameters["name"];
      if (node.type !== TIMELINE_VALUE_TYPE || typeof name !== "string") {
        continue;
      }
      const shape = timelineValueShape(node);
      const prior = first.get(name);
      if (prior === undefined) {
        first.set(name, shape);
      } else if (prior.type !== shape.type) {
        conflicts.push({
          graphIndex,
          error: {
            code: "param-uniform-type-conflict",
            message: `param uniform "${name}" is declared as both ${prior.type} and ${shape.type}`,
            params: { name, priorType: prior.type, newType: shape.type },
            nodeId: node.id,
          },
        });
      } else if (
        prior.value !== undefined &&
        shape.value !== undefined &&
        prior.value.some((component, index) => component !== shape.value?.[index])
      ) {
        conflicts.push({
          graphIndex,
          error: {
            code: "param-value-conflict",
            message: `Timeline Value "${name}" has a different default here than another declaration of it in this emitter`,
            params: { name },
            nodeId: node.id,
          },
        });
      }
    }
  });
  return conflicts;
}

/** The names some `timeline-value` node declares across graphs, keyframed or not. */
export function timelineValueNames(graphs: readonly EditorGraph[]): ReadonlySet<string> {
  return new Set(timelineValueDeclarations(graphs).keys());
}

/** Attribute element types a user attribute (and its `read`/`store` nodes) can carry. */
export const ATTRIBUTE_TYPES: readonly AttributeTypeName[] = ["float", "vec2", "vec3", "vec4"];

/**
 * Whether a name is a reserved builtin read source (so it cannot be declared as an attribute) -
 * matched case-insensitively so "Position"/"POSITION" are caught too, not just the lowercase spelling.
 */
export function isReservedAttributeName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(FX_READABLE_CORE_BUILTINS, name.toLowerCase());
}

// Re-exported from the engine so the "attr:" prefix has one definition.
export { attributeNameFromSlot } from "../engine/behavior/FXParticleBehaviorTarget";

/**
 * Engine-registered types the add-node menu hides: `store-attribute` writes are authored by
 * wiring a sink's `attr:<name>` slot; the `combine-mat{N}`/`split-mat{N}` variants are the
 * `nodeFamilies` facade's engine arm, never added directly.
 */
const EDITOR_HIDDEN_TYPES: ReadonlySet<string> = new Set([
  "store-attribute",
  "combine-mat2",
  "combine-mat3",
  "combine-mat4",
  "split-mat2",
  "split-mat3",
  "split-mat4",
]);

/** The full palette: every standard node's metadata plus the manual nodes' (minus hidden). */
export const NODE_PALETTE: readonly FXNodeMeta[] = [
  ...FX_STANDARD_NODES.map((definition) => definition.describe()),
  ...FX_MANUAL_NODE_METAS,
].filter((metadata) => !EDITOR_HIDDEN_TYPES.has(metadata.type));

/** Target inputs the particle host provides but a VFX mesh does not; a render node reading any of
 *  these cannot resolve on a mesh. Derived from the two targets so it never drifts. */
const PARTICLE_ONLY_RENDER_INPUTS: ReadonlySet<string> = new Set(
  buildParticleTarget()
    .inputs.map((input) => input.name)
    .filter((name) => !FX_MESH_TARGET.inputs.some((meshInput) => meshInput.name === name)),
);

/**
 * Whether a render node can't be offered on a VFX mesh: it reads a particle-only target input, or
 * its reads are attribute-dynamic. Mirrors the engine's own missing-input rejection, no hand-list.
 */
export function isMeshExcludedRenderNode(metadata: FXNodeMeta): boolean {
  return metadata.reads === "dynamic"
    ? true
    : metadata.reads.some((name) => PARTICLE_ONLY_RENDER_INPUTS.has(name));
}

/** Surface slots a VFX mesh has no place for (currently `particleTransform`), derived from the
 *  two targets. Persistence prunes a mesh render binding to one of these. */
export const PARTICLE_ONLY_SURFACE_SLOTS: ReadonlySet<string> = new Set(
  buildParticleTarget()
    .outputs.map((output) => output.slot)
    .filter((slot) => !FX_MESH_TARGET.outputs.some((output) => output.slot === slot)),
);

/** Target inputs the particle host provides but a trail or ribbon does not (the surface frame); a
 *  render node reading any of these cannot resolve in their graphs. Derived from the targets (the
 *  ribbon's builtins are the trail's). */
const TRAIL_MISSING_RENDER_INPUTS: ReadonlySet<string> = new Set(
  buildParticleTarget()
    .inputs.map((input) => input.name)
    .filter((name) => !FX_TRAIL_TARGET.inputs.some((trailInput) => trailInput.name === name)),
);

/**
 * Whether a render node can't be offered in a trail or ribbon graph: it reads an input their
 * targets lack (the lighting and surface-normal nodes). Attribute-dynamic reads are fine - a strip
 * reads attributes off the particles it runs through.
 */
export function isStripExcludedRenderNode(metadata: FXNodeMeta): boolean {
  return metadata.reads === "dynamic"
    ? false
    : metadata.reads.some((name) => TRAIL_MISSING_RENDER_INPUTS.has(name));
}

/** Surface slots a trail or ribbon has no place for (the particle transforms), derived from the
 *  targets. A strip binding to one of these is pruned on load like a mesh's. */
export const NON_STRIP_SURFACE_SLOTS: ReadonlySet<string> = new Set(
  buildParticleTarget()
    .outputs.map((output) => output.slot)
    .filter((slot) => !FX_TRAIL_TARGET.outputs.some((output) => output.slot === slot)),
);

function domainMatchesKind(domain: FXNodeMeta["domain"], kind: GraphKind): boolean {
  if (domain === "shared") {
    return true;
  }
  return domain === (kind === GraphKind.Render ? "render" : "behavior");
}

// Cached: the palette is fixed and this is called per node lookup.
const paletteByKind = new Map<GraphKind, readonly FXNodeMeta[]>();

/** The palette for one graph kind, ordered by category then `type` - a stable, locale-free base
 *  order. The final on-screen order is locale-aware and owned by the UI (the add-node menu
 *  re-sorts by its own resolved, translated label; see `ui/graph/addNodeMenu.ts`'s `open()`) -
 *  this domain layer never resolves display text (see `i18n/nodeText.ts`). Callers must treat the
 *  returned array as read-only (it is the shared cached view). */
export function paletteForKind(kind: GraphKind): readonly FXNodeMeta[] {
  const cached = paletteByKind.get(kind);
  if (cached !== undefined) {
    return cached;
  }
  const palette = NODE_PALETTE.filter((metadata) => domainMatchesKind(metadata.domain, kind)).sort(
    (first, second) => {
      if (first.category !== second.category) {
        return first.category.localeCompare(second.category);
      }
      return first.type.localeCompare(second.type);
    },
  );
  paletteByKind.set(kind, palette);
  return palette;
}

/**
 * Search words for a palette node: its enum and valueType option values and its category. Never
 * shown.
 */
export function searchTagsFor(metadata: FXNodeMeta): readonly string[] {
  const tags = new Set<string>();
  for (const parameter of Object.values(metadata.params)) {
    const options = (parameter as { options?: readonly unknown[] }).options;
    if (Array.isArray(options)) {
      for (const option of options) {
        if (typeof option === "string") {
          tags.add(option.replace(/-/g, " "));
        }
      }
    }
  }
  tags.add(metadata.category);
  return [...tags];
}

/**
 * Looks up a placed node's metadata, disambiguating the non-unique `type` by the active kind
 * so the render and behavior `life-ratio` never collide.
 */
export function metaFor(kind: GraphKind, type: string): FXNodeMeta | undefined {
  return paletteForKind(kind).find((metadata) => metadata.type === type);
}

/** Resolves a placed node's metadata, handling the reserved sinks (not in the palette; the
 *  surface sink's shape depends on `renderMode`). Falls back to {@link metaFor} otherwise. */
export function metaForNode(
  kind: GraphKind,
  node: { readonly type: string; readonly parameters: Readonly<Record<string, unknown>> },
  attributes: readonly EditorAttribute[] = [],
  host: RenderHost = DEFAULT_RENDER_HOST,
  meshAssetNames: readonly string[] = [],
): FXNodeMeta | undefined {
  if (isSinkType(node.type)) {
    return sinkMeta(node.type, {
      renderMode: coerceRenderMode(node.parameters["renderMode"]),
      renderHost: host,
      attributes,
      meshAssetNames,
    });
  }
  if (node.type === ROUTE_TYPE) {
    return routeMeta();
  }
  return metaFor(kind, node.type);
}

export { isFakeNodeType, ROUTE_TYPE } from "./fakeNodes";

/** A freshly created node's parameter bag: each schema parameter at its declared default. Custom
 *  params (names, textures, gradients) are left for the inline widgets to fill afterward. */
export function defaultParametersFor(metadata: FXNodeMeta): Record<string, unknown> {
  const parameters: Record<string, unknown> = {};
  for (const [key, parameter] of Object.entries(metadata.params)) {
    parameters[key] = parameter.default;
  }
  return parameters;
}

/** A socket's display label: its own `label`, or the humanized key when absent. */
export function socketLabel(socket: FXSocketMeta): string {
  return socket.label ?? humanizeKey(socket.key);
}

/** `inMin` -> "In Min", `edge0` -> "Edge0", `a` -> "A", `uv` -> "UV". */
export function humanizeKey(key: string): string {
  const spaced = key.replace(/([a-z])([A-Z])/g, "$1 $2");
  const titled = spaced.charAt(0).toUpperCase() + spaced.slice(1);
  // "UV" is an acronym: keep it uppercase wherever it appears as a whole word ("uv" ->
  // "UV", "uvOffset" -> "UV Offset") instead of the title-cased "Uv".
  return titled.replace(/\bUv\b/g, "UV");
}
