import type { FXNodeMeta, FXSocketMeta } from "../core/nodes/FXSocketSpec";
import { deepFreeze } from "../core/nodes/deepFreeze.Internal";
import type { FXGLSLTypeName } from "../core/socket/FXValueType";
import { NUMERIC_VALUE_TYPES } from "../core/socket/FXValueType";
import { FX_READABLE_CORE_BUILTINS } from "../core/socket/FXReadableBuiltins";

/**
 * Machine-readable palette metadata for the **hand-written** node classes that are not
 * `defineNode` descriptors; each class's static `describe()` returns its entry here. Params
 * {@link FXParamMeta} can't express (a free-string `name`, an opaque texture, a gradient) are
 * listed instead in {@link FXNodeMeta.customParams}, each with an editor-widget `kind`.
 */

/** Attribute element types a store/custom-attribute node can carry. */
const ATTRIBUTE_TYPES = NUMERIC_VALUE_TYPES;

/** The four host builtins `builtin-attribute` exposes, one output socket each - derived
 *  from the engine's read table so the two never drift. */
const BUILTIN_ATTRIBUTE_OUTPUTS: readonly FXSocketMeta[] = Object.entries(
  FX_READABLE_CORE_BUILTINS,
).map(([name, builtin]) => ({ key: name, type: builtin.type.glslTypeName }));

/** Host builtins `builtin-attribute` reads, for palette/target filtering (e.g. a VFX mesh,
 *  which has no particle state, excludes it). */
const BUILTIN_ATTRIBUTE_READS: readonly string[] = Object.values(FX_READABLE_CORE_BUILTINS).map(
  (builtin) => builtin.targetInput,
);

/**
 * Reader of all four host builtins at once (render/GPU side) - the fixed-shape counterpart of
 * `custom-attribute`'s by-name picker. No buffer reserved (reads host state directly), so
 * it takes no params at all - its shape never varies per instance.
 */
export const BUILTIN_ATTRIBUTE_META: FXNodeMeta = {
  type: "builtin-attribute",
  category: "attribute",
  domain: "render",
  stage: "param",
  inputs: [],
  outputs: BUILTIN_ATTRIBUTE_OUTPUTS,
  params: {},
  reads: BUILTIN_ATTRIBUTE_READS,
  cost: 0,
};

/** Behavior half of `builtin-attribute` (behavior/CPU side). */
export const BEHAVIOR_BUILTIN_ATTRIBUTE_META: FXNodeMeta = {
  type: "builtin-attribute",
  category: "attribute",
  domain: "behavior",
  phase: "param",
  inputs: [],
  outputs: BUILTIN_ATTRIBUTE_OUTPUTS,
  params: {},
  reads: BUILTIN_ATTRIBUTE_READS,
  cost: 0,
};

/** Reader half of the user-attribute channel (render/GPU side); its read set is name-dependent. */
export const CUSTOM_ATTRIBUTE_META: FXNodeMeta = {
  type: "custom-attribute",
  category: "attribute",
  domain: "render",
  stage: "param",
  inputs: [],
  outputs: [{ key: "value", type: "T" }],
  params: {
    type: {
      kind: "structural",
      type: "valueType",
      options: ATTRIBUTE_TYPES,
      default: "vec4",
    },
    // No `stage` param: placement is inferred, so `stage: "param"` above is palette
    // filtering only - mirroring the `defineNode` convention (no editable stage).
  },
  // The varying it reads is p_fx_<name>, which depends on the instance's name.
  reads: "dynamic",
  generic: { constraint: ATTRIBUTE_TYPES },
  customParams: [{ key: "name", kind: "attribute-name", required: true }],
  // A varying/buffer read, no arithmetic.
  cost: 0,
};

/** Reader half of the user-attribute channel (behavior/CPU side); its read set is name-dependent. */
export const BEHAVIOR_CUSTOM_ATTRIBUTE_META: FXNodeMeta = {
  type: "custom-attribute",
  category: "attribute",
  domain: "behavior",
  phase: "param",
  inputs: [],
  outputs: [{ key: "value", type: "T" }],
  params: {
    type: {
      kind: "structural",
      type: "valueType",
      options: ATTRIBUTE_TYPES,
      default: "vec4",
    },
    // No `phase` param: placement is inferred, so `phase: "param"` above is palette
    // filtering only - mirroring the `defineNode` convention (no editable phase).
  },
  // The target input it reads is ATTR_<name>, which depends on the instance's name.
  reads: "dynamic",
  generic: { constraint: ATTRIBUTE_TYPES },
  customParams: [{ key: "name", kind: "attribute-name", required: true }],
  // A buffer read, no arithmetic.
  cost: 0,
};

/**
 * Reader half of the user-attribute channel, fused with a `split`: its four float outputs are
 * always declared (mirrors the `split` node's own static descriptor - see `FXBehaviorNode
 * CustomAttributeSplit`/`FXRenderNodeCustomAttributeSplit`), and the editor's
 * `custom-attribute-split` node family (`domain/nodeFamilies.ts`) trims the unused
 * tail for display down to the selected attribute's actual width.
 */
export const CUSTOM_ATTRIBUTE_SPLIT_META: FXNodeMeta = {
  type: "custom-attribute-split",
  category: "attribute",
  domain: "render",
  stage: "param",
  inputs: [],
  outputs: [
    { key: "x", type: "float" },
    { key: "y", type: "float" },
    { key: "z", type: "float" },
    { key: "w", type: "float" },
  ],
  params: {
    type: {
      kind: "structural",
      type: "valueType",
      options: ATTRIBUTE_TYPES,
      default: "vec4",
    },
    // No `stage` param: placement is inferred, so `stage: "param"` above is palette
    // filtering only - mirroring `custom-attribute`.
  },
  // The varying it reads is p_fx_<name>, which depends on the instance's name.
  reads: "dynamic",
  // No socket here is literally "T" (the outputs are concrete floats, reshaped by the node family
  // instead - see the doc comment above), but `generic` still must be set: it is what gates
  // `resolveNodeMeta` into the family-lookup branch that does that reshaping.
  generic: { constraint: ATTRIBUTE_TYPES },
  customParams: [{ key: "name", kind: "attribute-name", required: true }],
  // A varying/buffer read plus a re-index, no arithmetic.
  cost: 0,
};

/** Behavior half of `custom-attribute-split` (behavior/CPU side); its read set is
 *  name-dependent. */
export const BEHAVIOR_CUSTOM_ATTRIBUTE_SPLIT_META: FXNodeMeta = {
  type: "custom-attribute-split",
  category: "attribute",
  domain: "behavior",
  phase: "param",
  inputs: [],
  outputs: [
    { key: "x", type: "float" },
    { key: "y", type: "float" },
    { key: "z", type: "float" },
    { key: "w", type: "float" },
  ],
  params: {
    type: {
      kind: "structural",
      type: "valueType",
      options: ATTRIBUTE_TYPES,
      default: "vec4",
    },
    // No `phase` param: placement is inferred, so `phase: "param"` above is palette
    // filtering only - mirroring `custom-attribute`.
  },
  // The target input it reads is ATTR_<name>, which depends on the instance's name.
  reads: "dynamic",
  // See the render meta's twin comment: no socket is literally "T", but `generic` still gates
  // `resolveNodeMeta` into the family-lookup branch that reshapes the outputs for display.
  generic: { constraint: ATTRIBUTE_TYPES },
  customParams: [{ key: "name", kind: "attribute-name", required: true }],
  // A buffer read plus a re-index, no arithmetic.
  cost: 0,
};

/** Writer half of the user-attribute channel; writes its input, reads nothing. */
export const STORE_ATTRIBUTE_META: FXNodeMeta = {
  type: "store-attribute",
  category: "attribute",
  domain: "behavior",
  phase: "param",
  inputs: [{ key: "value", type: "T", required: true }],
  outputs: [{ key: "value", type: "T" }],
  params: {
    type: {
      kind: "structural",
      type: "valueType",
      options: ATTRIBUTE_TYPES,
      default: "vec4",
    },
    phase: {
      kind: "structural",
      type: "enum",
      options: ["spawn", "update"],
      default: "spawn",
    },
  },
  reads: [],
  generic: { constraint: ATTRIBUTE_TYPES },
  customParams: [{ key: "name", kind: "attribute-name", required: true }],
  // A pass-through buffer write, no arithmetic.
  cost: 0,
};

/**
 * The `type` dropdown options for a Timeline Value: numeric value types plus the UI-only
 * `"color"` alias (`resolveParamType` maps it to `vec4`), mirroring `constant`.
 */
const TIMELINE_VALUE_TYPE_OPTIONS: readonly (FXGLSLTypeName | "color")[] = [
  ...NUMERIC_VALUE_TYPES,
  "color",
];

/**
 * A named, runtime-tunable **value** exposed as a shader uniform (render side) - unlike a
 * Constant it is not baked inline: it costs a slot and is driven live via {@link FXEmitter.applyValues}.
 */
export const TIMELINE_VALUE_RENDER_META: FXNodeMeta = {
  type: "timeline-value",
  category: "source",
  domain: "render",
  stage: "param",
  inputs: [],
  outputs: [{ key: "out", type: "T" }],
  params: {
    type: {
      kind: "structural",
      type: "valueType",
      options: TIMELINE_VALUE_TYPE_OPTIONS,
      default: "float",
    },
    value: { kind: "value", type: "generic", default: 0 },
  },
  reads: [],
  generic: { constraint: NUMERIC_VALUE_TYPES },
  customParams: [{ key: "name", kind: "param-name", required: true }],
  // A live uniform read, no arithmetic (like `constant`).
  cost: 0,
};

/** Behavior half of Timeline Value: the same named parameter as a live kernel binding. */
export const TIMELINE_VALUE_BEHAVIOR_META: FXNodeMeta = {
  type: "timeline-value",
  category: "source",
  domain: "behavior",
  phase: "param",
  inputs: [],
  outputs: [{ key: "out", type: "T" }],
  params: {
    type: {
      kind: "structural",
      type: "valueType",
      options: TIMELINE_VALUE_TYPE_OPTIONS,
      default: "float",
    },
    value: { kind: "value", type: "generic", default: 0 },
  },
  reads: [],
  generic: { constraint: NUMERIC_VALUE_TYPES },
  customParams: [{ key: "name", kind: "param-name", required: true }],
  // A live binding read, no arithmetic (like `constant`).
  cost: 0,
};

/**
 * A named **texture** asset: samples an external sampler (bound by the host by slot name) at
 * the given UV into an rgba color. Texture loading is out of scope here. Render only.
 */
export const TEXTURE_META: FXNodeMeta = {
  type: "texture",
  category: "color",
  domain: "render",
  stage: "fragment",
  inputs: [{ key: "uv", type: "vec2", default: { targetInput: "p_uv" } }],
  outputs: [{ key: "color", type: "vec4" }],
  params: {},
  reads: ["p_uv"],
  // Optional: with no texture picked the node samples nothing (transparent), so it stays valid.
  customParams: [{ key: "name", kind: "param-name", required: false }],
  // A hardware texture fetch (pricier than a plain ALU op) - the baseline assumes a texture is
  // actually picked; a specific instance with none set is cheaper (see the node's `estimateCost`).
  cost: 8,
};

/**
 * The manual node metas, for an editor to merge with `FX_STANDARD_NODES`'
 * `describe()` output into one palette. Order groups the attribute nodes first.
 */
export const FX_MANUAL_NODE_METAS: readonly FXNodeMeta[] = [
  BUILTIN_ATTRIBUTE_META,
  BEHAVIOR_BUILTIN_ATTRIBUTE_META,
  CUSTOM_ATTRIBUTE_META,
  BEHAVIOR_CUSTOM_ATTRIBUTE_META,
  CUSTOM_ATTRIBUTE_SPLIT_META,
  BEHAVIOR_CUSTOM_ATTRIBUTE_SPLIT_META,
  STORE_ATTRIBUTE_META,
  TIMELINE_VALUE_RENDER_META,
  TIMELINE_VALUE_BEHAVIOR_META,
  TEXTURE_META,
  // Deep-frozen (the same objects the classes' `describe()` return), so a mutating
  // palette consumer fails loudly instead of corrupting shared metadata (M9).
].map(deepFreeze);
