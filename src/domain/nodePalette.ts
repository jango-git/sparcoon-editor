/**
 * The editor's node palette, derived from the engine's node metadata (single source of truth) so
 * labels/sockets/params never drift. `type` is not globally unique (`life-ratio` exists in more
 * than one domain), so the editor buckets by graph kind (render/behavior; `shared` in both). The
 * reserved sink nodes' own identity and metadata construction live in `./sinkMeta` - re-exported
 * here so existing importers keep their one import path.
 */

import type { FXNodeMeta, FXSocketMeta } from "../engine/core/nodes/FXSocketSpec";
import { FX_READABLE_CORE_BUILTINS } from "../engine/core/socket/FXReadableBuiltins";
import { FX_STANDARD_NODES } from "../engine/nodes-std/index";
import { FX_MANUAL_NODE_METAS } from "../engine/nodes-std/manualNodeMetas";
import {
  buildParticleTarget,
  FX_MESH_TARGET,
} from "../engine/render/target/FXParticleRenderTarget";
import { ROUTE_TYPE, routeMeta } from "./fakeNodes";
import type { AttributeTypeName, EditorAttribute, EditorGraph } from "./graphModel";
import {
  coerceRenderMode,
  DEFAULT_RENDER_HOST,
  isSinkType,
  sinkMeta,
  type RenderHost,
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
  isSinkType,
  readRenderSinkConfig,
  readSpawnSinkConfig,
  RENDER_CAST_SHADOW_PARAM,
  RENDER_MODE_PARAM_KEY,
  RENDER_RECEIVE_SHADOW_PARAM,
  RENDER_SINK_ID,
  RENDER_SINK_TYPE,
  RENDER_SORT_INTERVAL_PARAM,
  sinkMeta,
  sinkPhase,
  SPAWN_EXPECTED_CAPACITY_PARAM,
  SPAWN_SINK_ID,
  SPAWN_SINK_TYPE,
  SPAWN_TRY_GPU_SIMULATION_PARAM,
  toArtifactGeometrySource,
  UPDATE_SINK_ID,
  UPDATE_SINK_TYPE,
  type GeometryKind,
  type GeometrySource,
  type RenderHost,
  type RenderMode,
  type RenderSinkConfig,
  type SinkMetaOptions,
  type SpawnSinkConfig,
} from "./sinkMeta";

/** Which authored graph a node belongs to. Maps to the engine node `domain`. */
export enum GraphKind {
  Render = "render",
  Behavior = "behavior",
}

/** The timeline-value node - a named, runtime-tunable uniform input, drawn with a distinct accent. */
export const TIMELINE_VALUE_TYPE = "timeline-value";

/** Whether a node type gets the timeline-value accent styling (the `texture` node is also a
 *  runtime input but carries its own inline preview, so it is deliberately not tinted). */
export function isTimelineValueType(type: string): boolean {
  return type === TIMELINE_VALUE_TYPE;
}

/**
 * The parameter names some `timeline-value` node declares across `graphs`, independent of whether
 * keyframed - shared by the model (pruning an orphaned track) and the UI (which rows to show).
 */
export function timelineValueNames(graphs: readonly EditorGraph[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const graph of graphs) {
    for (const node of Object.values(graph.nodes)) {
      if (node.type === TIMELINE_VALUE_TYPE && typeof node.parameters["name"] === "string") {
        names.add(node.parameters["name"]);
      }
    }
  }
  return names;
}

/** Attribute element types a user attribute (and its `read`/`store` nodes) can carry. */
export const ATTRIBUTE_TYPES: readonly AttributeTypeName[] = ["float", "vec2", "vec3", "vec4"];

/** Host builtins a `read-attribute` node can read, offered alongside declared attributes. Derived
 *  from the engine's read table so the two never drift; names are reserved (can't be shadowed). */
export const READABLE_BUILTINS: readonly EditorAttribute[] = Object.entries(
  FX_READABLE_CORE_BUILTINS,
).map(([name, builtin]) => ({ name, type: builtin.type.glslTypeName as AttributeTypeName }));

/** Whether a name is a reserved builtin read source (so it cannot be declared as an attribute). */
export function isReservedAttributeName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(FX_READABLE_CORE_BUILTINS, name);
}

// Re-exported (not re-derived) so serialize/node-view code shares the engine's own inverse of
// `attributeSlot`, rather than a second hand-written "attr:" prefix that could drift from it.
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

function domainMatchesKind(domain: FXNodeMeta["domain"], kind: GraphKind): boolean {
  if (domain === "shared") {
    return true;
  }
  return domain === (kind === GraphKind.Render ? "render" : "behavior");
}

// NODE_PALETTE is fixed for the module lifetime, so each kind's filtered+sorted view is too;
// cache it - metaFor/metaForNode call this per node lookup (including recursive type resolution).
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

/** The structural invisible search vocabulary for a palette node: every enum/valueType option
 *  value plus the coarse `category`. Never rendered, matched only by search. Curated per-language
 *  synonyms ("swirl" surfaces Vortex) live in the node-text dictionary instead (`i18n/nodeText.ts`'s
 *  `nodeSearchTags`) - a UI-layer concern, folded in by the caller alongside these. */
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

// Re-exported so canvas/serialize code can classify fake nodes through the palette.
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
