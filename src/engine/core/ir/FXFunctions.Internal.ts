import type { FXGLSLTypeName } from "../socket/FXValueType";
import { NUMERIC_VALUE_TYPES } from "../socket/FXValueType";
import type { FXCallSignature } from "./FXExprBuilder";
import type { FXHelper, FXHelperModule } from "./FXHelperModule.Internal";
import { FX_GLSL_STANDARD_NOISE_HASH } from "./noise/FXNoiseHash.Internal";
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
  /** Helper the baseline-tier GLSL printer must emit once (a string is keyed by {@link name}). */
  readonly glslBaselineHelper?: FXHelper;
  /** Helper the JS printer must emit once (a string is keyed by {@link name}). */
  readonly jsHelper?: FXHelper;
  /**
   * Sibling GLSL form {@link printGLSLStandard} prefers over `glslBaseline` - only for a function
   * whose codegen genuinely differs between tiers (e.g. a future native op under GLSL3 vs a
   * polyfill under GLSL ES 1.00). Most functions never need this; a brand-new WebGL2-only
   * function (see {@link standardOnly}) also uses this pair rather than
   * `glslBaseline`/`glslBaselineHelper`.
   */
  readonly glslStandard?: string | ((args: readonly string[]) => string);
  /** Helper {@link printGLSLStandard} must emit once, in place of `glslBaselineHelper`. */
  readonly glslStandardHelper?: FXHelper;
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

// exportTypeScript.ts matches a compiled kernel's helper source against these constants to
// emit a `sparcoon` import instead of inlining text - must stay in lockstep with fxMath.ts.
export const FX_FRACT_HELPER = "function fxFract(x) { return x - Math.floor(x); }";
export const FX_MOD_HELPER = "function fxMod(a, b) { return a - b * Math.floor(a / b); }";
export const FX_MIX_HELPER = "function fxMix(a, b, t) { return a + (b - a) * t; }";
export const FX_SMOOTHSTEP_HELPER =
  "function fxSmoothstep(e0, e1, x) { var t = Math.min(Math.max((x - e0) / (e1 - e0), 0.0), 1.0); return t * t * (3.0 - 2.0 * t); }";

/**
 * Standard-tier `rand()`: hashes (vertex id, per-tick seed, call counter). `fxRandCounter` is a
 * per-invocation global, so it only decorrelates the several `rand()` calls within one
 * invocation; `gl_VertexID` and `u_fxRandSeed` (an `int` uniform the behavior assembler declares
 * and the runtime changes every tick) decorrelate particles and ticks.
 */
const FX_RAND_GLSL_STANDARD_HELPER: FXHelperModule = {
  key: "rand",
  requires: [FX_GLSL_STANDARD_NOISE_HASH.module],
  source: `
int fxRandCounter = 0;
float fxNextRandom(){
  fxRandCounter+=1;
  return fxUnit(fxPcg(fxLattice(uvec3(uint(gl_VertexID),uint(u_fxRandSeed),uint(fxRandCounter)))));
}`,
};

/**
 * `fx`-prefixed GLSL helpers for transpose/determinant/inverse (GLSL ES 1.00 has no matrix
 * builtins). `js` here is unreachable - `scalarize` expands these to scalar arithmetic first.
 */
const FX_MAT_TRANSPOSE_HELPER = `
mat2 fxTranspose(mat2 m){return mat2(m[0][0],m[1][0],m[0][1],m[1][1]);}
mat3 fxTranspose(mat3 m){return mat3(m[0][0],m[1][0],m[2][0],m[0][1],m[1][1],m[2][1],m[0][2],m[1][2],m[2][2]);}
mat4 fxTranspose(mat4 m){return mat4(
  m[0][0],m[1][0],m[2][0],m[3][0],
  m[0][1],m[1][1],m[2][1],m[3][1],
  m[0][2],m[1][2],m[2][2],m[3][2],
  m[0][3],m[1][3],m[2][3],m[3][3]);}`;

const FX_MAT_DETERMINANT_HELPER = `
float fxDeterminant(mat2 m){return m[0][0]*m[1][1]-m[0][1]*m[1][0];}
float fxDeterminant(mat3 m){
  return m[0][0]*(m[1][1]*m[2][2]-m[2][1]*m[1][2])
        -m[1][0]*(m[0][1]*m[2][2]-m[2][1]*m[0][2])
        +m[2][0]*(m[0][1]*m[1][2]-m[1][1]*m[0][2]);}
float fxDeterminant(mat4 m){
  float b00=m[0][0]*m[1][1]-m[0][1]*m[1][0];
  float b01=m[0][0]*m[1][2]-m[0][2]*m[1][0];
  float b02=m[0][0]*m[1][3]-m[0][3]*m[1][0];
  float b03=m[0][1]*m[1][2]-m[0][2]*m[1][1];
  float b04=m[0][1]*m[1][3]-m[0][3]*m[1][1];
  float b05=m[0][2]*m[1][3]-m[0][3]*m[1][2];
  float b06=m[2][0]*m[3][1]-m[2][1]*m[3][0];
  float b07=m[2][0]*m[3][2]-m[2][2]*m[3][0];
  float b08=m[2][0]*m[3][3]-m[2][3]*m[3][0];
  float b09=m[2][1]*m[3][2]-m[2][2]*m[3][1];
  float b10=m[2][1]*m[3][3]-m[2][3]*m[3][1];
  float b11=m[2][2]*m[3][3]-m[2][3]*m[3][2];
  return b00*b11-b01*b10+b02*b09+b03*b08-b04*b07+b05*b06;}`;

const FX_MAT_INVERSE_HELPER = `
mat2 fxInverse(mat2 m){
  return mat2(m[1][1],-m[0][1],-m[1][0],m[0][0])/(m[0][0]*m[1][1]-m[0][1]*m[1][0]);}
mat3 fxInverse(mat3 m){
  float a00=m[0][0],a01=m[0][1],a02=m[0][2];
  float a10=m[1][0],a11=m[1][1],a12=m[1][2];
  float a20=m[2][0],a21=m[2][1],a22=m[2][2];
  float b01=a22*a11-a12*a21;
  float b11=-a22*a10+a12*a20;
  float b21=a21*a10-a11*a20;
  float det=a00*b01+a01*b11+a02*b21;
  return mat3(b01,(-a22*a01+a02*a21),(a12*a01-a02*a11),
              b11,(a22*a00-a02*a20),(-a12*a00+a02*a10),
              b21,(-a21*a00+a01*a20),(a11*a00-a01*a10))/det;}
mat4 fxInverse(mat4 m){
  float a00=m[0][0],a01=m[0][1],a02=m[0][2],a03=m[0][3];
  float a10=m[1][0],a11=m[1][1],a12=m[1][2],a13=m[1][3];
  float a20=m[2][0],a21=m[2][1],a22=m[2][2],a23=m[2][3];
  float a30=m[3][0],a31=m[3][1],a32=m[3][2],a33=m[3][3];
  float b00=a00*a11-a01*a10;
  float b01=a00*a12-a02*a10;
  float b02=a00*a13-a03*a10;
  float b03=a01*a12-a02*a11;
  float b04=a01*a13-a03*a11;
  float b05=a02*a13-a03*a12;
  float b06=a20*a31-a21*a30;
  float b07=a20*a32-a22*a30;
  float b08=a20*a33-a23*a30;
  float b09=a21*a32-a22*a31;
  float b10=a21*a33-a23*a31;
  float b11=a22*a33-a23*a32;
  float det=b00*b11-b01*b10+b02*b09+b03*b08-b04*b07+b05*b06;
  return mat4(
    a11*b11-a12*b10+a13*b09, a02*b10-a01*b11-a03*b09, a31*b05-a32*b04+a33*b03, a22*b04-a21*b05-a23*b03,
    a12*b08-a10*b11-a13*b07, a00*b11-a02*b08+a03*b07, a32*b02-a30*b05-a33*b01, a20*b05-a22*b02+a23*b01,
    a10*b10-a11*b08+a13*b06, a01*b08-a00*b10-a03*b06, a30*b04-a31*b02+a33*b00, a21*b02-a20*b04-a23*b00,
    a11*b07-a10*b09-a12*b06, a00*b09-a01*b07+a02*b06, a31*b01-a30*b03-a32*b00, a20*b03-a21*b01+a22*b00)/det;}`;

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
    jsHelper: FX_FRACT_HELPER,
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
    jsHelper: FX_MOD_HELPER,
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
    jsHelper: FX_MIX_HELPER,
  });
  definitions.push({
    name: "smoothstep",
    signatures: [
      ...NUMERIC.map((type) => ({ args: [type, type, type] as const, result: type })),
      ...VECTORS.map((type) => ({ args: ["float", "float", type] as const, result: type })),
    ],
    js: (args) => `fxSmoothstep(${args[0]}, ${args[1]}, ${args[2]})`,
    jsHelper: FX_SMOOTHSTEP_HELPER,
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
    glslStandardHelper: FX_RAND_GLSL_STANDARD_HELPER,
    glslStandard: () => "fxNextRandom()",
    js: () => "Math.random()",
  });

  // Volume-mode radius sampling (spawn-sphere/spawn-cone) needs a real cube root; GLSL has no
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
  });
  definitions.push({
    name: "dot",
    signatures: VECTORS.map((type) => ({ args: [type, type], result: "float" as const })),
    js: noScalarJS("dot"),
  });
  definitions.push({
    name: "normalize",
    signatures: VECTORS.map((type) => ({ args: [type], result: type })),
    js: noScalarJS("normalize"),
  });
  // Native GLSL `cross` is vec3-only; the scalarizer expands it for the behavior/JS backend.
  definitions.push({
    name: "cross",
    signatures: [{ args: ["vec3", "vec3"] as const, result: "vec3" as const }],
    js: noScalarJS("cross"),
  });

  // Matrix functions: each an fx-prefixed GLSL helper so it works on WebGL1 (GLSL ES
  // 1.00, no matrix builtins); `scalarize` expands them for JS, so `js` never runs.
  definitions.push({
    name: "transpose",
    signatures: MATRICES.map((type) => ({ args: [type], result: type })),
    glslBaseline: "fxTranspose",
    glslBaselineHelper: FX_MAT_TRANSPOSE_HELPER,
    js: noScalarJS("transpose"),
  });
  definitions.push({
    name: "determinant",
    signatures: MATRICES.map((type) => ({ args: [type], result: "float" as const })),
    glslBaseline: "fxDeterminant",
    glslBaselineHelper: FX_MAT_DETERMINANT_HELPER,
    js: noScalarJS("determinant"),
  });
  definitions.push({
    name: "inverse",
    signatures: MATRICES.map((type) => ({ args: [type], result: type })),
    glslBaseline: "fxInverse",
    glslBaselineHelper: FX_MAT_INVERSE_HELPER,
    js: noScalarJS("inverse"),
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

  return new Map(definitions.map((definition) => [definition.name, definition]));
}

/** The canonical, backend-neutral function registry. */
export const FX_FUNCTIONS: ReadonlyMap<string, FXFunctionDef> = buildFunctions();

/** Whether `fn` is one of {@link FX_FUNCTIONS}' impure functions (`rand`), which no pass may share
 *  or move. */
export function isImpureFunction(fn: string): boolean {
  return FX_FUNCTIONS.get(fn)?.impure === true;
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
