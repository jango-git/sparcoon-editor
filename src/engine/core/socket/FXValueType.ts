/**
 * Three-independent GLSL value type system for socket typing and codegen. Mirrors
 * `GLTypeInfo` (instancedParticle/glTypeInfo) but stays three-free; mapped only at the
 * material adapter boundary.
 */

/**
 * Backend-neutral identity of a value type. Structural code (CSE hash-cons, signatures,
 * cache keys) keys on this id, not on `glslTypeName` - kept as a separate field so a future
 * non-GLSL backend is not forced to inherit GLSL spelling as its internal type key.
 */
export type FXValueTypeId =
  | "float"
  | "vec2"
  | "vec3"
  | "vec4"
  | "mat2"
  | "mat3"
  | "mat4"
  | "sampler2D"
  | "int"
  | "ivec2"
  | "ivec3"
  | "ivec4";

/** GLSL spelling of each type, emitted into shader source. */
export type FXGLSLTypeName = FXValueTypeId;

/** Structural description of a value type. */
export interface FXValueType {
  readonly id: FXValueTypeId;
  /** Render/GLSL backend only. */
  readonly glslTypeName: FXGLSLTypeName;
  /** Float component count, or `-1` for an opaque type (e.g. a sampler). */
  readonly components: number;
  /** Whether a value of this type can be declared as a local/varying. */
  readonly instantiable: boolean;
}

/** Canonical, frozen {@link FXValueType} singletons keyed by {@link FXValueTypeId}. */
export const FX_VALUE_TYPES: Readonly<Record<FXValueTypeId, FXValueType>> = Object.freeze({
  float: Object.freeze({ id: "float", glslTypeName: "float", components: 1, instantiable: true }),
  vec2: Object.freeze({ id: "vec2", glslTypeName: "vec2", components: 2, instantiable: true }),
  vec3: Object.freeze({ id: "vec3", glslTypeName: "vec3", components: 3, instantiable: true }),
  vec4: Object.freeze({ id: "vec4", glslTypeName: "vec4", components: 4, instantiable: true }),
  mat2: Object.freeze({ id: "mat2", glslTypeName: "mat2", components: 4, instantiable: true }),
  mat3: Object.freeze({ id: "mat3", glslTypeName: "mat3", components: 9, instantiable: true }),
  mat4: Object.freeze({ id: "mat4", glslTypeName: "mat4", components: 16, instantiable: true }),
  sampler2D: Object.freeze({
    id: "sampler2D",
    glslTypeName: "sampler2D",
    components: -1,
    instantiable: false,
  }),
  // WebGL2/GLSL-ES-3.00-only: never available to the baseline (WebGL1) compiler, and never
  // implicitly interconvertible with float/vecN (isNumericType excludes this family below) - a
  // graph crosses the boundary only through an explicit cast.
  int: Object.freeze({ id: "int", glslTypeName: "int", components: 1, instantiable: true }),
  ivec2: Object.freeze({ id: "ivec2", glslTypeName: "ivec2", components: 2, instantiable: true }),
  ivec3: Object.freeze({ id: "ivec3", glslTypeName: "ivec3", components: 3, instantiable: true }),
  ivec4: Object.freeze({ id: "ivec4", glslTypeName: "ivec4", components: 4, instantiable: true }),
});

/** Resolves a type name to its canonical {@link FXValueType}. */
export function resolveValueType(name: FXValueTypeId): FXValueType {
  return FX_VALUE_TYPES[name];
}

const VALUE_TYPE_IDS: ReadonlySet<string> = new Set(Object.keys(FX_VALUE_TYPES));

/** Whether an arbitrary string is a valid {@link FXValueTypeId} - the safe way to key {@link FX_VALUE_TYPES}. */
export function isValueTypeId(value: string): value is FXValueTypeId {
  return VALUE_TYPE_IDS.has(value);
}

/**
 * The interconvertible numeric value types (`float`/`vec2`/`vec3`/`vec4`) - the single source for
 * the generic-node numeric constraint and the param/attribute type menu (they are the same set).
 */
export const NUMERIC_VALUE_TYPES: readonly FXGLSLTypeName[] = ["float", "vec2", "vec3", "vec4"];

/**
 * A polymorphic socket type: a node carries at most one type variable `T`, unified to a
 * concrete {@link FXValueType} by {@link resolveGenerics} - from its connected generic
 * inputs, or from an explicit annotation when it is a source (`constant`, `combine`).
 */
export interface FXGenericType {
  readonly generic: "T";
  /** Concrete GLSL types `T` may resolve to. */
  readonly constraint: readonly FXGLSLTypeName[];
}

/** A socket's declared type: a concrete value type, or the node's generic `T`. */
export type FXSocketType = FXValueType | FXGenericType;

/** Narrows a socket type to its generic form. */
export function isGenericType(type: FXSocketType): type is FXGenericType {
  return "generic" in type;
}

/** Whether a type is one of the square matrix types (`mat2`/`mat3`/`mat4`). */
export function isMatrixType(type: FXValueType): boolean {
  const id = type.id;
  return id === "mat2" || id === "mat3" || id === "mat4";
}

/** Square-matrix dimension from its flat component count (`4->2`, `9->3`, `16->4`). */
export function matrixDimension(components: number): number {
  return Math.round(Math.sqrt(components));
}

/** Whether a type is one of the integer types (`int`/`ivec2`/`ivec3`/`ivec4`). */
export function isIntType(type: FXValueType): boolean {
  const id = type.id;
  return id === "int" || id === "ivec2" || id === "ivec3" || id === "ivec4";
}

/**
 * Whether a type is one of the interconvertible numeric widths (`float`/`vecN`).
 *
 * Matrices are excluded explicitly: `mat2` carries 4 float components just like `vec4`,
 * so a bare component-count test would wrongly let a matrix interconvert with a vector.
 * The `int`/`ivecN` family is excluded the same way: `ivec4` also carries 4 components, and
 * letting it through here would silently make it numeric-interconvertible with `vec4` via
 * `coerceNumeric` - exactly the implicit int<->float coercion this type family must never
 * have (a graph crosses the boundary only through an explicit cast; see `toInt`/`toFloat`).
 */
export function isNumericType(type: FXValueType): boolean {
  return !isMatrixType(type) && !isIntType(type) && type.components >= 1 && type.components <= 4;
}

/**
 * Whether a value produced on `from` may feed a socket typed `to`. Identical types always
 * match; the numeric widths (`float`/`vecN`) also interconvert implicitly (`coerceNumeric`
 * pads/truncates/splats at codegen). Matrices and samplers still require an exact match.
 */
export function areTypesCompatible(from: FXValueType, to: FXValueType): boolean {
  if (from.id === to.id) {
    return true;
  }
  return isNumericType(from) && isNumericType(to);
}
