import type { FXNodeMeta } from "../core/nodes/FXSocketSpec";
import { deepFreeze } from "../core/nodes/deepFreeze.Internal";
import type { FXGLSLTypeName } from "../core/socket/FXValueType";
import { NUMERIC_VALUE_TYPES } from "../core/socket/FXValueType";

/**
 * Machine-readable palette metadata for the **hand-written** node classes that are not
 * `defineNode` descriptors; each class's static `describe()` returns its entry here. Params
 * {@link FXParamMeta} can't express (a free-string `name`, an opaque texture, a gradient) are
 * listed instead in {@link FXNodeMeta.customParams}, each with an editor-widget `kind`.
 */

/** Attribute element types a store/read-attribute node can carry. */
const ATTRIBUTE_TYPES = NUMERIC_VALUE_TYPES;

/** Reader half of the user-attribute channel (render/GPU side); its read set is name-dependent. */
export const READ_ATTRIBUTE_META: FXNodeMeta = {
  type: "read-attribute",
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
export const BEHAVIOR_READ_ATTRIBUTE_META: FXNodeMeta = {
  type: "read-attribute",
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
 * ReadAttributeComponents`/`FXRenderNodeReadAttributeComponents`), and the editor's
 * `read-attribute-components` node family (`domain/nodeFamilies.ts`) trims the unused tail for
 * display down to the selected attribute's actual width.
 */
export const READ_ATTRIBUTE_COMPONENTS_META: FXNodeMeta = {
  type: "read-attribute-components",
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
    // filtering only - mirroring `read-attribute`.
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

/** Behavior half of `read-attribute-components` (behavior/CPU side); its read set is name-dependent. */
export const BEHAVIOR_READ_ATTRIBUTE_COMPONENTS_META: FXNodeMeta = {
  type: "read-attribute-components",
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
    // filtering only - mirroring `read-attribute`.
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
 * `describe()` output into one palette. Order groups the two attribute nodes first.
 */
export const FX_MANUAL_NODE_METAS: readonly FXNodeMeta[] = [
  READ_ATTRIBUTE_META,
  BEHAVIOR_READ_ATTRIBUTE_META,
  READ_ATTRIBUTE_COMPONENTS_META,
  BEHAVIOR_READ_ATTRIBUTE_COMPONENTS_META,
  STORE_ATTRIBUTE_META,
  TIMELINE_VALUE_RENDER_META,
  TIMELINE_VALUE_BEHAVIOR_META,
  TEXTURE_META,
  // Deep-frozen (the same objects the classes' `describe()` return), so a mutating
  // palette consumer fails loudly instead of corrupting shared metadata (M9).
].map(deepFreeze);
