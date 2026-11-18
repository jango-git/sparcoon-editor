import { FX_SURFACE_TEXEL_FLOATS } from "sparcoon";
import { FX_NO_SURFACE_DISTANCE } from "sparcoon/helpers";

import type { FXGLSLTypeName } from "../socket/FXValueType";
import { NUMERIC_VALUE_TYPES } from "../socket/FXValueType";
import type { FXCallSignature } from "./FXExprBuilder";
import type { FXGLSLHelperName, FXJSHelperName } from "./FXHelpers.Internal";
import { noiseFunctionDefinitions } from "./noise/FXNoiseFunctions.Internal";

/**
 * The backend-neutral function registry: each entry names a function, its signatures, and how
 * it prints to GLSL and to (scalarized) JS - `js` only ever prints the scalar overload.
 */
export interface FXFunctionDef {
  readonly name: string;
  /** Allowed overloads: exact argument types -> result type. */
  readonly signatures: readonly FXCallSignature[];
  /**
   * Baseline-tier (GLSL ES 1.00 / WebGL1) printing: a builtin name (`"atan"`) or a template over
   * printed args. Defaults to `name(...)` when omitted. Also the fallback the standard tier reads
   * when it has no `glslStandard` override of its own (see {@link glslStandard}).
   */
  readonly glslBaseline?: string | ((args: readonly string[]) => string);
  /** JS printing of the scalar overload, over already-printed argument strings. */
  readonly js: (args: readonly string[]) => string;
  /** The helper the baseline-tier GLSL calls. */
  readonly glslBaselineHelper?: FXGLSLHelperName;
  /** The helpers the JS may call. */
  readonly jsHelper?: readonly FXJSHelperName[];
  /**
   * Sibling GLSL form {@link printGLSLStandard} prefers over `glslBaseline` - only for a function
   * whose codegen genuinely differs between tiers (e.g. a future native op under GLSL3 vs a
   * polyfill under GLSL ES 1.00). Most functions never need this; a brand-new WebGL2-only
   * function (see {@link standardOnly}) also uses this pair rather than
   * `glslBaseline`/`glslBaselineHelper`.
   */
  readonly glslStandard?: string | ((args: readonly string[]) => string);
  /** The helper {@link printGLSLStandard} links in place of `glslBaselineHelper`. */
  readonly glslStandardHelper?: FXGLSLHelperName;
  /**
   * Scalarizes as one opaque call rather than element-wise: vector arguments are flattened into
   * scalar ones, and a vecN result becomes N calls with the component index appended.
   */
  readonly packed?: true;
  /**
   * True for a function with no baseline-tier (GLSL ES 1.00 / WebGL1) form at all - e.g. a
   * bitwise op, `texelFetch`. Excluded from {@link baselineSignaturesFrom}'s signature map
   * entirely, so a node calling it under the baseline compiler's builders throws at build time
   * (`fn.call`: unknown function) unless the node supplies a `baselineBuild` that avoids it.
   */
  readonly standardOnly?: true;
  /**
   * True for a function whose result is not determined by its printed arguments alone (currently
   * only `rand`) - every call is a fresh, independent draw, even a zero-arg one that would
   * otherwise look identical to every other call of the same function. The JS-backend optimizer
   * (`codegen/cse.Internal.ts`) must never common-subexpression-eliminate or loop-hoist a call
   * marked `impure`, the same way it already excludes `raw` nodes for exactly this reason.
   */
  readonly impure?: true;
  /**
   * True for a function a component of whose result reads other components of its arguments - a
   * vector reduction (`length`, `dot`), `normalize`, `cross`, a matrix function. Every other
   * function is element-wise (vector arguments component for component, a scalar one splatted) or
   * {@link packed}; `scalarize` expands each of these by its own formula.
   */
  readonly crossComponent?: true;
}

const NUMERIC = NUMERIC_VALUE_TYPES;
const VECTORS: readonly FXGLSLTypeName[] = ["vec2", "vec3", "vec4"];

/** `f(T) -> T` for every float/vecN type. */
function elementwiseUnary(): FXCallSignature[] {
  return NUMERIC.map((type) => ({ args: [type], result: type }));
}

/** `f(T, T) -> T` for every float/vecN type. */
function elementwiseBinary(): FXCallSignature[] {
  return NUMERIC.map((type) => ({ args: [type, type], result: type }));
}

function rightScalar(): FXCallSignature[] {
  return VECTORS.map((type) => ({ args: [type, "float"] as const, result: type }));
}

/** Scalar-only JS helper: used where the value has no `Math.*` counterpart. */
function noScalarJS(name: string): (args: readonly string[]) => string {
  return (): string => {
    throw new Error(`sparcoon IR: "${name}" has no scalar JS form; the scalarizer must expand it`);
  };
}

/**
 * GLSL/JS names line up (`Math.<fn>`) for these pure unary ops. `round` is excluded - GLSL ES
 * 1.00 has no `round()`, so it prints specially below.
 */
const UNARY_MATH: readonly string[] = [
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "exp",
  "log",
  "sqrt",
  "abs",
  "floor",
  "ceil",
  "sign",
];

/** mat2 / mat3 / mat4 - the square matrix types the matrix functions overload over. */
const MATRICES: readonly FXGLSLTypeName[] = ["mat2", "mat3", "mat4"];

function buildFunctions(): Map<string, FXFunctionDef> {
  const definitions: FXFunctionDef[] = [];

  for (const name of UNARY_MATH) {
    definitions.push({
      name,
      signatures: elementwiseUnary(),
      js: (args) => `Math.${name}(${args[0]})`,
    });
  }

  definitions.push({
    name: "fract",
    signatures: elementwiseUnary(),
    js: (args) => `fxFract(${args[0]})`,
    jsHelper: ["fxFract"],
  });

  // GLSL ES 1.00 has no round(), and ES 3.00's round-half-to-even differs from Math.round;
  // floor(x + 0.5) is round-half-up on both and matches Math.round exactly.
  definitions.push({
    name: "round",
    signatures: elementwiseUnary(),
    glslBaseline: (args) => `floor(${args[0]} + 0.5)`,
    js: (args) => `Math.round(${args[0]})`,
  });

  // Paired element-wise, with a right-hand scalar splat where GLSL allows it.
  definitions.push({
    name: "min",
    signatures: [...elementwiseBinary(), ...rightScalar()],
    js: (args) => `Math.min(${args[0]}, ${args[1]})`,
  });
  definitions.push({
    name: "max",
    signatures: [...elementwiseBinary(), ...rightScalar()],
    js: (args) => `Math.max(${args[0]}, ${args[1]})`,
  });
  definitions.push({
    name: "pow",
    signatures: elementwiseBinary(),
    js: (args) => `Math.pow(${args[0]}, ${args[1]})`,
  });
  definitions.push({
    name: "mod",
    signatures: [...elementwiseBinary(), ...rightScalar()],
    js: (args) => `fxMod(${args[0]}, ${args[1]})`,
    jsHelper: ["fxMod"],
  });
  definitions.push({
    name: "step",
    // step(edge, x): a left-hand scalar edge splats against a vector x.
    signatures: [
      ...elementwiseBinary(),
      ...VECTORS.map((type) => ({ args: ["float", type] as const, result: type })),
    ],
    js: (args) => `(${args[1]} < ${args[0]} ? 0.0 : 1.0)`,
  });

  definitions.push({
    name: "atan2",
    signatures: [{ args: ["float", "float"], result: "float" }],
    glslBaseline: "atan",
    js: (args) => `Math.atan2(${args[0]}, ${args[1]})`,
  });

  definitions.push({
    name: "clamp",
    signatures: [
      ...NUMERIC.map((type) => ({ args: [type, type, type] as const, result: type })),
      ...VECTORS.map((type) => ({ args: [type, "float", "float"] as const, result: type })),
    ],
    js: (args) => `Math.min(Math.max(${args[0]}, ${args[1]}), ${args[2]})`,
  });
  definitions.push({
    name: "mix",
    signatures: [
      ...NUMERIC.map((type) => ({ args: [type, type, type] as const, result: type })),
      ...VECTORS.map((type) => ({ args: [type, type, "float"] as const, result: type })),
    ],
    js: (args) => `fxMix(${args[0]}, ${args[1]}, ${args[2]})`,
    jsHelper: ["fxMix"],
  });
  definitions.push({
    name: "smoothstep",
    signatures: [
      ...NUMERIC.map((type) => ({ args: [type, type, type] as const, result: type })),
      ...VECTORS.map((type) => ({ args: ["float", "float", type] as const, result: type })),
    ],
    js: (args) => `fxSmoothstep(${args[0]}, ${args[1]}, ${args[2]})`,
    jsHelper: ["fxSmoothstep"],
  });

  definitions.push({
    name: "saturate",
    signatures: elementwiseUnary(),
    glslBaseline: (args) => `clamp(${args[0]}, 0.0, 1.0)`,
    js: (args) => `Math.min(Math.max(${args[0]}, 0.0), 1.0)`,
  });
  definitions.push({
    name: "oneMinus",
    signatures: elementwiseUnary(),
    glslBaseline: (args) => `(1.0 - ${args[0]})`,
    js: (args) => `(1.0 - ${args[0]})`,
  });

  definitions.push(...noiseFunctionDefinitions());

  // A fresh draw in [0, 1), zero graph-authored args - decorrelation across the several `rand()`
  // calls one node's build() can make is a shader-local concern (a `fxRandCounter` global,
  // incremented per call within one invocation), not something the IR/args need to carry. JS keeps
  // real entropy (`Math.random()`); GLSL has none, so it hashes (gl_VertexID, a per-tick seed
  // uniform the standard-tier behavior assembler must declare as `u_fxRandSeed`, the call counter).
  // `standardOnly`: `gl_VertexID` and the bitwise mixing below need GLSL ES 3.00 - no baseline form.
  definitions.push({
    name: "rand",
    signatures: [{ args: [], result: "float" }],
    standardOnly: true,
    impure: true,
    glslStandardHelper: "FX_GLSL_RAND",
    glslStandard: () => "fxNextRandom()",
    js: () => "Math.random()",
  });

  // Volume-mode radius sampling (random-sphere-point/random-cone-point) needs a real cube root; GLSL has no
  // `cbrt`, but every call site's argument is non-negative (a [0,1) random draw), where
  // pow(x, 1/3) agrees with cbrt exactly - same spelling works under both GLSL tiers.
  definitions.push({
    name: "cbrt",
    signatures: [{ args: ["float"], result: "float" }],
    glslBaseline: (args) => `pow(${args[0]}, 1.0 / 3.0)`,
    js: (args) => `Math.cbrt(${args[0]})`,
  });

  // Vector reductions: expanded by the scalarizer, never printed as scalar JS.
  definitions.push({
    name: "length",
    signatures: VECTORS.map((type) => ({ args: [type], result: "float" as const })),
    js: noScalarJS("length"),
    crossComponent: true,
  });
  definitions.push({
    name: "dot",
    signatures: VECTORS.map((type) => ({ args: [type, type], result: "float" as const })),
    js: noScalarJS("dot"),
    crossComponent: true,
  });
  definitions.push({
    name: "normalize",
    signatures: VECTORS.map((type) => ({ args: [type], result: type })),
    js: noScalarJS("normalize"),
    crossComponent: true,
  });
  // Native GLSL `cross` is vec3-only; the scalarizer expands it for the behavior/JS backend.
  definitions.push({
    name: "cross",
    signatures: [{ args: ["vec3", "vec3"] as const, result: "vec3" as const }],
    js: noScalarJS("cross"),
    crossComponent: true,
  });

  // Matrix functions: each an fx-prefixed GLSL helper so it works on WebGL1 (GLSL ES
  // 1.00, no matrix builtins); `scalarize` expands them for JS, so `js` never runs.
  definitions.push({
    name: "transpose",
    signatures: MATRICES.map((type) => ({ args: [type], result: type })),
    glslBaseline: "fxTranspose",
    glslBaselineHelper: "FX_GLSL_TRANSPOSE",
    js: noScalarJS("transpose"),
    crossComponent: true,
  });
  definitions.push({
    name: "determinant",
    signatures: MATRICES.map((type) => ({ args: [type], result: "float" as const })),
    glslBaseline: "fxDeterminant",
    glslBaselineHelper: "FX_GLSL_DETERMINANT",
    js: noScalarJS("determinant"),
    crossComponent: true,
  });
  definitions.push({
    name: "inverse",
    signatures: MATRICES.map((type) => ({ args: [type], result: type })),
    glslBaseline: "fxInverse",
    glslBaselineHelper: "FX_GLSL_INVERSE",
    js: noScalarJS("inverse"),
    crossComponent: true,
  });

  // Bitwise int ops: GLSL ES 1.00 has no bitwise operators at all (unlike int arithmetic, which
  // is tier-neutral and goes through the ordinary `+`/`*` builders once both operands are
  // `int`/`ivecN` - see FXExprBuilder.ts's `isScalarOrVector`). These three are genuinely
  // WebGL2/GLSL-ES-3.00-only: `standardOnly` excludes them from the baseline compiler's signature
  // map (`baselineSignaturesFrom`), so `fn.call` throws "unknown function" under the baseline tier
  // unless the calling node supplies a `baselineBuild`.
  definitions.push({
    name: "intXor",
    signatures: [{ args: ["int", "int"], result: "int" }],
    standardOnly: true,
    glslStandard: (args) => `(${args[0]} ^ ${args[1]})`,
    js: noScalarJS("intXor"),
  });
  definitions.push({
    name: "intAnd",
    signatures: [{ args: ["int", "int"], result: "int" }],
    standardOnly: true,
    glslStandard: (args) => `(${args[0]} & ${args[1]})`,
    js: noScalarJS("intAnd"),
  });
  definitions.push({
    name: "intShiftLeft",
    signatures: [{ args: ["int", "int"], result: "int" }],
    standardOnly: true,
    glslStandard: (args) => `(${args[0]} << ${args[1]})`,
    js: noScalarJS("intShiftLeft"),
  });

  // One texel of a mesh surface table (sparcoon's `surfaceTableLayout.ts`), by its index: an
  // RGBA32F texture on the GPU, rows as wide as the texture, and the table's Float32Array on the
  // CPU. The table never reaches WebGL1 (the JS kernel runs there), so it has no baseline form.
  definitions.push({
    name: "meshFetch",
    signatures: [{ args: ["sampler2D", "float"], result: "vec4" }],
    standardOnly: true,
    packed: true,
    glslStandard: (args) => `fxMeshFetch(${args[0]}, ${args[1]})`,
    glslStandardHelper: "FX_GLSL_MESH_FETCH",
    js: (args) => `${args[0]}[${args[1]} * ${String(FX_SURFACE_TEXEL_FLOATS)} + ${args[2]}]`,
  });

  // A volume (sparcoon's `volumeTableLayout.ts`) at texture coordinates `uvw`, filtered linearly
  // between texel centres and clamped to the edge texels - the R8 3D texture on the GPU, and the
  // table's Float32Array read the same way on the CPU. No baseline form, as `meshFetch`.
  definitions.push({
    name: "volumeFetch",
    signatures: [{ args: ["sampler3D", "vec3"], result: "float" }],
    standardOnly: true,
    packed: true,
    glslStandard: (args) => `texture(${args[0]}, ${args[1]}).r`,
    js: (args) => `fxVolumeFetch(${args.join(", ")})`,
    jsHelper: ["fxVolumeFetch"],
  });
  // A volume's size in texels.
  definitions.push({
    name: "volumeSize",
    signatures: [{ args: ["sampler3D"], result: "vec3" }],
    standardOnly: true,
    packed: true,
    glslStandard: (args) => `vec3(textureSize(${args[0]}, 0))`,
    // The header's components lie at the table's start.
    js: (args) => `${args[0]}[${args[1]}]`,
  });

  // The surface of the scene depth at a world-space point, as `vec4(normal, distance)` - see
  // FX_GLSL_SCENE_DEPTH_CONTACT. The depth reaches only the GPU simulation: on the CPU, as where
  // the GPU has no depth to read, there is no surface.
  definitions.push({
    name: "sceneDepthContact",
    signatures: [{ args: ["vec3", "float"], result: "vec4" }],
    standardOnly: true,
    packed: true,
    glslStandard: (args) => `fxSceneDepthContact(${args[0]}, ${args[1]})`,
    glslStandardHelper: "FX_GLSL_SCENE_DEPTH_CONTACT",
    // The component index comes last, after the point's three components and the thickness.
    js: (args) => `[${NO_SURFACE_CONTACT.join(", ")}][${args[4]}]`,
  });

  return new Map(definitions.map((definition) => [definition.name, definition]));
}

/** `sceneDepthContact` where there is no surface: an up normal and the no-surface distance. */
const NO_SURFACE_CONTACT = [0, 1, 0, FX_NO_SURFACE_DISTANCE] as const;

/** The canonical, backend-neutral function registry. */
export const FX_FUNCTIONS: ReadonlyMap<string, FXFunctionDef> = buildFunctions();

/** Whether `fn` is one of {@link FX_FUNCTIONS}' impure functions (`rand`), which no pass may share
 *  or move. */
export function isImpureFunction(fn: string): boolean {
  return FX_FUNCTIONS.get(fn)?.impure === true;
}

/** Whether `fn` computes each result component from the same component of each vector argument
 *  (a scalar argument splatted) - neither {@link FXFunctionDef.packed} nor
 *  {@link FXFunctionDef.crossComponent}, nor impure. */
export function isElementwiseFunction(fn: string): boolean {
  const def = FX_FUNCTIONS.get(fn);
  return (
    def !== undefined && def.packed !== true && def.crossComponent !== true && def.impure !== true
  );
}

/**
 * Extracts the call-signature registry from a function-definition map, for `createBuilders` to
 * bind a backend's `call` against - each backend derives its own map from its own function set.
 */
export function signaturesFrom(
  functions: ReadonlyMap<string, FXFunctionDef>,
): Map<string, readonly FXCallSignature[]> {
  return new Map([...functions].map(([name, definition]) => [name, definition.signatures]));
}

/**
 * {@link signaturesFrom}, minus every `standardOnly` entry - the baseline (WebGL1) compiler's
 * `call` registry, so `fn.call("texelFetch", ...)` throws "unknown function" at build time for a
 * node with no `baselineBuild` to fall back to instead.
 */
export function baselineSignaturesFrom(
  functions: ReadonlyMap<string, FXFunctionDef>,
): Map<string, readonly FXCallSignature[]> {
  return new Map(
    [...functions]
      .filter(([, definition]) => definition.standardOnly !== true)
      .map(([name, definition]) => [name, definition.signatures]),
  );
}
