/**
 * Node families: an editor facade (`combine`/`split`) whose socket shape varies by resolved type,
 * unlike the engine's uniform generic `"T"`; serialize expands each to its concrete engine node.
 */

import type { FXSocketMeta } from "../engine/core/nodes/FXSocketSpec";
import type { FXGLSLTypeName, FXValueType } from "../engine/core/socket/FXValueType";
import {
  FX_VALUE_TYPES,
  isMatrixType,
  matrixDimension,
  NUMERIC_VALUE_TYPES,
} from "../engine/core/socket/FXValueType";

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
      // Read from FX_VALUE_TYPES because a bare "float" literal widens to string through this
      // array's inference.
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
 * `custom-attribute-split`: `custom-attribute` fused with `split`, with the width taken from the
 * attribute's `type` param. There is no matrix variant, so serialize passes it through.
 */
const CUSTOM_ATTRIBUTE_SPLIT_FAMILY: NodeFamily = {
  facadeType: "custom-attribute-split",
  typeParamKey: "type",
  options: NUMERIC_VALUE_TYPES,
  resolveVariant(parameters) {
    return coerceParamType(this, parameters, "vec4");
  },
  sockets(resolvedType) {
    const valueType = valueTypeOf(resolvedType) ?? FX_VALUE_TYPES.vec4;
    const outputs = COMPONENT_KEYS.slice(0, valueType.components).map((key) => ({
      key,
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
  CUSTOM_ATTRIBUTE_SPLIT_FAMILY,
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
 * Drops component params that do not fit the facade's current variant (for example after a
 * `combine` type change). Values on merely inactive pins are kept.
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
