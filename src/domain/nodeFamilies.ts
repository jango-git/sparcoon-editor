/**
 * Node families: an editor facade (`combine`/`split`) whose socket shape varies by resolved type,
 * unlike the engine's uniform generic `"T"`; serialize expands each to its concrete engine node.
 */

import type { FXGLSLTypeName, FXValueType } from "../engine/core/socket/FXValueType";
import {
  FX_VALUE_TYPES,
  isMatrixType,
  matrixDimension,
  NUMERIC_VALUE_TYPES,
} from "../engine/core/socket/FXValueType";
import type { FXSocketMeta } from "../engine/core/nodes/FXSocketSpec";

/** The concrete type wired into one of a placed node's inputs (undefined if unconnected). */
export type ResolveWired = (inputKey: string) => FXGLSLTypeName | undefined;

/** Component socket keys a family reuses across every variant (so wires/inline values survive a reshape). */
const COMPONENT_KEYS = ["x", "y", "z", "w"] as const;

/** Default inline value per component, matching the engine `fxCombine` defaults (x/y/z = 0, w = 1). */
const COMPONENT_DEFAULTS: Readonly<Record<(typeof COMPONENT_KEYS)[number], number>> = {
  x: 0,
  y: 0,
  z: 0,
  w: 1,
};

/** The concrete engine node a serialized facade expands to: its type plus cleaned params. */
export interface FamilyExpansion {
  readonly type: string;
  readonly params: Readonly<Record<string, unknown>>;
}

/** The reshaped sockets a family variant exposes for one resolved type. */
export interface FamilySockets {
  readonly inputs: readonly FXSocketMeta[];
  readonly outputs: readonly FXSocketMeta[];
}

/** A facade node backed by a family of concrete engine variants of differing socket shape. */
export interface NodeFamily {
  /** The facade node type shown in the palette (also the vector variants' engine type). */
  readonly facadeType: string;
  /** Every concrete type the facade spans. For a param-driven family this is also its `type` menu. */
  readonly options: readonly FXGLSLTypeName[];
  /** Param-driven families (combine): the structural `valueType` param key. Absent for wire-driven (split). */
  readonly typeParamKey?: string;
  /** The resolved variant type of a placed node (`undefined` when undeterminable, e.g. an unwired split). */
  resolveVariant(
    parameters: Readonly<Record<string, unknown>>,
    resolveWired: ResolveWired,
  ): FXGLSLTypeName | undefined;
  /** The reshaped sockets for a resolved variant (`undefined` => the neutral/unresolved shape). */
  sockets(resolvedType: FXGLSLTypeName | undefined): FamilySockets;
  /** Rewrites a placed facade node to its concrete engine node (type + sanitized params). */
  serialize(
    parameters: Readonly<Record<string, unknown>>,
    resolveWired: ResolveWired,
  ): FamilyExpansion;
}

/** The canonical value type for a name, or `undefined` for an unknown/garbage name. */
function valueTypeOf(name: FXGLSLTypeName | undefined): FXValueType | undefined {
  return name === undefined ? undefined : FX_VALUE_TYPES[name];
}

/** float / vec2 / vec3 / vec4 (the interconvertible numeric widths - a matrix is excluded). */
function isVectorType(type: FXValueType): boolean {
  return !isMatrixType(type) && type.components >= 2 && type.components <= 4;
}

/** The identity matrix's column `index` at dimension `dimension` (a 1 on the diagonal, else 0). */
function identityColumn(dimension: number, index: number): number[] {
  return Array.from({ length: dimension }, (_, row) => (row === index ? 1 : 0));
}

/** Whether a stored inline value fits a socket of the given float-width (scalar for 1, else a vecN array). */
function valueFitsWidth(value: unknown, width: number): boolean {
  return width === 1 ? typeof value === "number" : Array.isArray(value) && value.length === width;
}

/** The stored `type` param coerced to a known variant (falling back to `fallback`). */
function coerceParamType(
  family: NodeFamily,
  parameters: Readonly<Record<string, unknown>>,
  fallback: FXGLSLTypeName,
): FXGLSLTypeName {
  const raw = parameters[family.typeParamKey ?? ""];
  return family.options.includes(raw as FXGLSLTypeName) ? (raw as FXGLSLTypeName) : fallback;
}

/** `combine`: assemble a `vecN` from N floats, or a `matN` from N `vecN` columns (param-driven). */
const COMBINE_FAMILY: NodeFamily = {
  facadeType: "combine",
  typeParamKey: "type",
  options: ["vec2", "vec3", "vec4", "mat2", "mat3", "mat4"],
  resolveVariant(parameters) {
    return coerceParamType(this, parameters, "vec3");
  },
  sockets(resolvedType) {
    const valueType = valueTypeOf(resolvedType) ?? FX_VALUE_TYPES.vec3;
    if (isMatrixType(valueType)) {
      const dimension = matrixDimension(valueType.components);
      const columnType = `vec${dimension.toString()}` as FXGLSLTypeName;
      const inputs = COMPONENT_KEYS.slice(0, dimension).map((key, i) => ({
        key,
        type: columnType,
        label: `Column ${i.toString()}`,
        // Unconnected columns default to the identity, so a bare node yields the identity matrix.
        control: { default: identityColumn(dimension, i) },
      }));
      return { inputs, outputs: [{ key: "out", type: valueType.id, label: "Matrix" }] };
    }
    // Vector: N float inputs, defaults from COMPONENT_DEFAULTS (x/y/z = 0, w = 1).
    const inputs = COMPONENT_KEYS.slice(0, valueType.components).map((key) => ({
      key,
      // Read off FX_VALUE_TYPES (typed as FXGLSLTypeName), not the "float" literal directly - a
      // bare literal here widens to `string` once this object flows back out through this array's
      // own inference, past the point a same-line type assertion could narrow it again.
      type: FX_VALUE_TYPES.float.id,
      label: key.toUpperCase(),
      control: { default: COMPONENT_DEFAULTS[key] },
    }));
    return { inputs, outputs: [{ key: "out", type: valueType.id, label: "Vector" }] };
  },
  serialize(parameters) {
    const resolvedType = coerceParamType(this, parameters, "vec3");
    const valueType = FX_VALUE_TYPES[resolvedType];
    const matrix = isMatrixType(valueType);
    const dimension = matrix ? matrixDimension(valueType.components) : valueType.components;
    // `applyParams` coerces every component socket and throws on a mismatched-length array, so a
    // stale vecN value from a prior matrix variant must be dropped, not passed through.
    const columnWidth = matrix ? dimension : 1;
    const activeCount = matrix ? dimension : COMPONENT_KEYS.length;
    const engineType = matrix ? `combine-mat${dimension.toString()}` : this.facadeType;
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parameters)) {
      if (key === this.typeParamKey) {
        if (!matrix) {
          cleaned[key] = value; // the generic vector node reads its `type` annotation
        }
        continue;
      }
      const componentIndex = (COMPONENT_KEYS as readonly string[]).indexOf(key);
      if (componentIndex !== -1) {
        if (componentIndex < activeCount && valueFitsWidth(value, columnWidth)) {
          cleaned[key] = value;
        }
        continue;
      }
      cleaned[key] = value;
    }
    return { type: engineType, params: cleaned };
  },
};

/** The `split` facade's neutral (unresolved) shape: a generic input + four float component outputs. */
function splitNeutralSockets(): FamilySockets {
  const outputs = COMPONENT_KEYS.map((key) => ({
    key,
    // See COMBINE_FAMILY's identical comment: read off FX_VALUE_TYPES, not the literal.
    type: FX_VALUE_TYPES.float.id,
    label: key.toUpperCase(),
  }));
  return { inputs: [{ key: "v", type: "T", label: "Vector", required: true }], outputs };
}

/** `split`: decompose a `vecN` into N floats, or a `matN` into N `vecN` columns (wire-driven). */
const SPLIT_FAMILY: NodeFamily = {
  facadeType: "split",
  options: ["vec2", "vec3", "vec4", "mat2", "mat3", "mat4"],
  resolveVariant(_parameters, resolveWired) {
    const wired = resolveWired("v");
    // Only a vec/mat resolves to a variant; anything else keeps the neutral shape.
    return wired !== undefined && this.options.includes(wired) ? wired : undefined;
  },
  sockets(resolvedType) {
    const valueType = valueTypeOf(resolvedType);
    if (valueType === undefined) {
      return splitNeutralSockets();
    }
    if (isMatrixType(valueType)) {
      const dimension = matrixDimension(valueType.components);
      const columnType = `vec${dimension.toString()}` as FXGLSLTypeName;
      const outputs = COMPONENT_KEYS.slice(0, dimension).map((key, i) => ({
        key,
        type: columnType,
        label: `Column ${i.toString()}`,
      }));
      return {
        inputs: [{ key: "v", type: valueType.id, label: "Matrix", required: true }],
        outputs,
      };
    }
    if (!isVectorType(valueType)) {
      return splitNeutralSockets();
    }
    const outputs = COMPONENT_KEYS.slice(0, valueType.components).map((key) => ({
      key,
      // See COMBINE_FAMILY's identical comment: read off FX_VALUE_TYPES, not the literal.
      type: FX_VALUE_TYPES.float.id,
      label: key.toUpperCase(),
    }));
    return { inputs: [{ key: "v", type: valueType.id, label: "Vector", required: true }], outputs };
  },
  serialize(parameters, resolveWired) {
    const resolvedType = this.resolveVariant(parameters, resolveWired);
    const valueType = valueTypeOf(resolvedType);
    if (valueType !== undefined && isMatrixType(valueType)) {
      return {
        type: `split-mat${matrixDimension(valueType.components).toString()}`,
        params: parameters,
      };
    }
    // Vector (or unresolved): the generic `split` node handles it via the engine's own `T`.
    return { type: this.facadeType, params: parameters };
  },
};

/**
 * `read-attribute-components`: the fused `read-attribute` + `split` (param-driven, like
 * `combine` - the width comes from the selected attribute's own `type` param, not a wired input).
 * A user attribute is never a matrix, so unlike `combine`/`split` there is no matrix variant to
 * expand to at serialize; the one engine node type handles every width (float/vec2/vec3/vec4)
 * itself, so `serialize` is an identity passthrough.
 */
const READ_ATTRIBUTE_COMPONENTS_FAMILY: NodeFamily = {
  facadeType: "read-attribute-components",
  typeParamKey: "type",
  options: NUMERIC_VALUE_TYPES,
  resolveVariant(parameters) {
    return coerceParamType(this, parameters, "vec4");
  },
  sockets(resolvedType) {
    const valueType = valueTypeOf(resolvedType) ?? FX_VALUE_TYPES.vec4;
    const outputs = COMPONENT_KEYS.slice(0, valueType.components).map((key) => ({
      key,
      // See COMBINE_FAMILY's identical comment: read off FX_VALUE_TYPES, not the literal.
      type: FX_VALUE_TYPES.float.id,
      label: key.toUpperCase(),
    }));
    return { inputs: [], outputs };
  },
  serialize(parameters) {
    return { type: this.facadeType, params: parameters };
  },
};

const FAMILIES: readonly NodeFamily[] = [
  COMBINE_FAMILY,
  SPLIT_FAMILY,
  READ_ATTRIBUTE_COMPONENTS_FAMILY,
];

/** The family a node type is the facade of, or `undefined` when it is an ordinary node. */
export function nodeFamily(facadeType: string): NodeFamily | undefined {
  return FAMILIES.find((family) => family.facadeType === facadeType);
}

/**
 * Expands a placed facade node to the concrete engine node it serializes to, or `undefined` for an
 * ordinary node. Socket keys are shared across variants, so connections never need rewriting.
 */
export function expandFamilyNode(
  type: string,
  parameters: Readonly<Record<string, unknown>>,
  resolveWired: ResolveWired,
): FamilyExpansion | undefined {
  return nodeFamily(type)?.serialize(parameters, resolveWired);
}

/**
 * Prunes component params that no longer fit the facade's current variant shape (e.g. after a
 * `combine` type change), so the editor never shows a stale value on a resized pin. A value on a
 * pin merely *inactive* (hidden by a narrower vector) is left alone, so it survives a round-trip.
 */
export function pruneStaleFamilyComponents(
  family: NodeFamily,
  parameters: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const resolvedType = family.resolveVariant(parameters, () => undefined);
  const widthByKey = new Map(
    family.sockets(resolvedType).inputs.flatMap((socket) => {
      const valueType = valueTypeOf(socket.type === "T" ? undefined : socket.type);
      return valueType === undefined ? [] : [[socket.key, valueType.components] as const];
    }),
  );
  const pruned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parameters)) {
    const width = widthByKey.get(key);
    if (width !== undefined && !valueFitsWidth(value, width)) {
      continue; // Stale value for the new pin shape - drop so the pin reverts to its control default.
    }
    pruned[key] = value;
  }
  return pruned;
}
