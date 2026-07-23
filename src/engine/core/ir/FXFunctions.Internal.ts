import type { FXGLSLTypeName } from "../socket/FXValueType";
import { NUMERIC_VALUE_TYPES } from "../socket/FXValueType";
import type { FXCallSignature } from "./FXExprBuilder";

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
  /** Helper source the baseline-tier GLSL printer must emit once (keyed by {@link name}). */
  readonly glslBaselineHelper?: string;
  /** Helper source the JS printer must emit once (keyed by {@link name}). */
  readonly jsHelper?: string;
  /**
   * Sibling GLSL form {@link printGLSLStandard} prefers over `glslBaseline` - only for a function
   * whose codegen genuinely differs between tiers (e.g. a future native op under GLSL3 vs a
   * polyfill under GLSL ES 1.00). Most functions never need this; a brand-new WebGL2-only
   * function (see {@link standardOnly}) also uses this pair rather than
   * `glslBaseline`/`glslBaselineHelper`.
   */
  readonly glslStandard?: string | ((args: readonly string[]) => string);
  /** Helper source {@link printGLSLStandard} must emit once, in place of `glslBaselineHelper`. */
  readonly glslStandardHelper?: string;
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
 * Baseline-tier (GLSL ES 1.00 / WebGL1) noise: smoothed hash-corner value noise, 1D/2D/3D. GLSL
 * ES 1.00 has no bitwise operators (see the `standardOnly` int functions below), so this tier can
 * never use an integer hash - `sin`-based hashing is the only option available to it, always.
 * Each `noise(...)` overload hashes the corners of the cell containing its argument and blends
 * them with a Hermite (smoothstep) weight; output is remapped from the hash's natural [0, 1] to
 * [-1, 1] so every tier/dimension shares one output contract.
 */
const FX_NOISE_GLSL_BASELINE_HELPER = `
float fxHash1(float n){float s=sin(n*127.1)*43758.5453123;return s-floor(s);}
float fxHash2(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float fxHash3(vec3 p){p=fract(p*vec3(443.897,441.423,437.195));p+=dot(p,p.yzx+19.19);return fract((p.x+p.y)*p.z);}
float noise(float x){
  float i=floor(x);
  float f=x-i;
  float u=f*f*(3.0-2.0*f);
  return (fxHash1(i)*(1.0-u)+fxHash1(i+1.0)*u)*2.0-1.0;
}
float noise(vec2 p){
  vec2 i=floor(p);
  vec2 f=fract(p);
  vec2 u=f*f*(3.0-2.0*f);
  float a=fxHash2(i);
  float b=fxHash2(i+vec2(1.0,0.0));
  float c=fxHash2(i+vec2(0.0,1.0));
  float d=fxHash2(i+vec2(1.0,1.0));
  return mix(mix(a,b,u.x),mix(c,d,u.x),u.y)*2.0-1.0;
}
float noise(vec3 p){
  vec3 i=floor(p);
  vec3 f=fract(p);
  vec3 u=f*f*(3.0-2.0*f);
  float a=fxHash3(i+vec3(0.0,0.0,0.0));
  float b=fxHash3(i+vec3(1.0,0.0,0.0));
  float c=fxHash3(i+vec3(0.0,1.0,0.0));
  float d=fxHash3(i+vec3(1.0,1.0,0.0));
  float e=fxHash3(i+vec3(0.0,0.0,1.0));
  float f2=fxHash3(i+vec3(1.0,0.0,1.0));
  float g=fxHash3(i+vec3(0.0,1.0,1.0));
  float h=fxHash3(i+vec3(1.0,1.0,1.0));
  return mix(mix(mix(a,b,u.x),mix(c,d,u.x),u.y),mix(mix(e,f2,u.x),mix(g,h,u.x),u.y),u.z)*2.0-1.0;
}`;

/**
 * Standard-tier (GLSL ES 3.00 / WebGL2) noise: same value-noise scaffold as
 * {@link FX_NOISE_GLSL_BASELINE_HELPER} (hash the containing cell's corners, Hermite-blend them),
 * but each corner is hashed with a real integer bit-scramble (Ken Perlin's classic `IntNoise`)
 * instead of a `sin`-hash - cheaper and free of `sin`'s precision loss at large coordinates. Only
 * legal where `int` has guaranteed 32-bit range and bitwise operators exist (GLSL ES 3.00; ES 1.00
 * has neither guarantee) - the reason this tier is `standardOnly`, not a style preference.
 */
const FX_NOISE_GLSL_STANDARD_HELPER = `
float fxIntHash1(int n){
  int shifted=n<<13;
  int mixed=shifted^n;
  int squared=mixed*mixed;
  int step1=squared*15731+mixed*789221;
  int step2=step1*step1+1376312589;
  int masked=step2&0x00ffffff;
  return float(masked)/16777216.0;
}
float noise(float x){
  int i=int(floor(x));
  float f=x-floor(x);
  float u=f*f*(3.0-2.0*f);
  return (fxIntHash1(i)*(1.0-u)+fxIntHash1(i+1)*u)*2.0-1.0;
}
float noise(vec2 p){
  vec2 fl=floor(p);
  int ix=int(fl.x);
  int iy=int(fl.y);
  vec2 f=p-fl;
  vec2 u=f*f*(3.0-2.0*f);
  float a=fxIntHash1(ix+iy*57);
  float b=fxIntHash1(ix+1+iy*57);
  float c=fxIntHash1(ix+(iy+1)*57);
  float d=fxIntHash1(ix+1+(iy+1)*57);
  return mix(mix(a,b,u.x),mix(c,d,u.x),u.y)*2.0-1.0;
}
float noise(vec3 p){
  vec3 fl=floor(p);
  int ix=int(fl.x);
  int iy=int(fl.y);
  int iz=int(fl.z);
  vec3 f=p-fl;
  vec3 u=f*f*(3.0-2.0*f);
  float a=fxIntHash1(ix+iy*57+iz*113);
  float b=fxIntHash1(ix+1+iy*57+iz*113);
  float c=fxIntHash1(ix+(iy+1)*57+iz*113);
  float d=fxIntHash1(ix+1+(iy+1)*57+iz*113);
  float e=fxIntHash1(ix+iy*57+(iz+1)*113);
  float f2=fxIntHash1(ix+1+iy*57+(iz+1)*113);
  float g=fxIntHash1(ix+(iy+1)*57+(iz+1)*113);
  float h=fxIntHash1(ix+1+(iy+1)*57+(iz+1)*113);
  return mix(mix(mix(a,b,u.x),mix(c,d,u.x),u.y),mix(mix(e,f2,u.x),mix(g,h,u.x),u.y),u.z)*2.0-1.0;
}`;

/**
 * The scalar (CPU/behavior) twin of {@link FX_NOISE_GLSL_STANDARD_HELPER}: JS has no `int` type
 * or ES-1.00-style bitwise restriction, so the JS form always uses the integer hash (matching
 * `glslStandard`, never `glslBaseline`) - keeping GLSL and JS symmetric on the cheaper/higher-
 * quality integer-hash primitive rather than simplex. `Math.imul` plus
 * `| 0` truncation at each step mirrors GLSL's 32-bit `int` wraparound so the two tracks agree.
 * Takes vector components as separate float args (see the `noise` case in `scalarize`).
 */
export const FX_NOISE_JS_HELPER = `
function fxIntHash1(n){
  var shifted=(n<<13)|0;
  var mixed=(shifted^n)|0;
  var squared=Math.imul(mixed,mixed);
  var step1=(Math.imul(squared,15731)+Math.imul(mixed,789221))|0;
  var step2=(Math.imul(step1,step1)+1376312589)|0;
  return (step2&0x00ffffff)/16777216.0;
}
function fxIntHash2(ix,iy){return fxIntHash1((ix+Math.imul(iy,57))|0);}
function fxIntHash3(ix,iy,iz){return fxIntHash1((ix+Math.imul(iy,57)+Math.imul(iz,113))|0);}
function fxNoise1(x){
  var i=Math.floor(x);
  var f=x-i;
  var u=f*f*(3-2*f);
  return (fxIntHash1(i)*(1-u)+fxIntHash1(i+1)*u)*2-1;
}
function fxNoise2(vx,vy){
  var ix=Math.floor(vx),iy=Math.floor(vy);
  var fx=vx-ix,fy=vy-iy;
  var ux=fx*fx*(3-2*fx),uy=fy*fy*(3-2*fy);
  var a=fxIntHash2(ix,iy),b=fxIntHash2(ix+1,iy),c=fxIntHash2(ix,iy+1),d=fxIntHash2(ix+1,iy+1);
  var ab=a+(b-a)*ux,cd=c+(d-c)*ux;
  return (ab+(cd-ab)*uy)*2-1;
}
function fxNoise3(vx,vy,vz){
  var ix=Math.floor(vx),iy=Math.floor(vy),iz=Math.floor(vz);
  var fx=vx-ix,fy=vy-iy,fz=vz-iz;
  var ux=fx*fx*(3-2*fx),uy=fy*fy*(3-2*fy),uz=fz*fz*(3-2*fz);
  var a=fxIntHash3(ix,iy,iz),b=fxIntHash3(ix+1,iy,iz);
  var c=fxIntHash3(ix,iy+1,iz),d=fxIntHash3(ix+1,iy+1,iz);
  var e=fxIntHash3(ix,iy,iz+1),f=fxIntHash3(ix+1,iy,iz+1);
  var g=fxIntHash3(ix,iy+1,iz+1),h=fxIntHash3(ix+1,iy+1,iz+1);
  var ab=a+(b-a)*ux,cd=c+(d-c)*ux,abcd=ab+(cd-ab)*uy;
  var ef=e+(f-e)*ux,gh=g+(h-g)*ux,efgh=ef+(gh-ef)*uy;
  return (abcd+(efgh-abcd)*uz)*2-1;
}`;

/**
 * Standard-tier `rand()`: the same shift/xor/multiply bit-mixing shape as {@link
 * FX_NOISE_GLSL_STANDARD_HELPER}'s `fxIntHash1`, under a distinct name (`fxRandHash1`, not
 * `fxIntHash1`) - the GLSL-standard printer dedups a function's helper by that function's own
 * name (`noise` vs `rand`), not by helper text, so reusing `fxIntHash1` verbatim here would emit
 * two conflicting `fxIntHash1` definitions whenever a graph calls both `noise` and `rand`.
 * `fxRandCounter` is an ordinary GLSL global: every shader invocation (one per particle) gets its
 * own fresh copy, reset to `0`, so it only decorrelates the several `rand()` calls *within* one
 * invocation - decorrelating across particles and across ticks is `gl_VertexID`/`u_fxRandSeed`'s
 * job. `u_fxRandSeed` is a contract with the standard-tier behavior assembler (not yet built): an
 * `int` uniform it must declare and the runtime must change every tick.
 */
const FX_RAND_GLSL_STANDARD_HELPER = `
int fxRandCounter = 0;
float fxRandHash1(int n){
  int shifted=n<<13;
  int mixed=shifted^n;
  int squared=mixed*mixed;
  int step1=squared*15731+mixed*789221;
  int step2=step1*step1+1376312589;
  int masked=step2&0x00ffffff;
  return float(masked)/16777216.0;
}
float fxNextRandom(){
  fxRandCounter+=1;
  int combined=gl_VertexID+u_fxRandSeed*57+fxRandCounter*113;
  return fxRandHash1(combined);
}`;

/**
 * Maximum `fbm` octaves. `octaves` is an ordinary runtime argument (a live, per-particle-variable
 * input in the graphs that use it, not a compile-time constant), so the loop bound is clamped hard
 * inside the helper itself - else a runaway value freezes the tab (JS) or blows the GPU's loop
 * budget (GLSL). Exported so a node exposing `octaves` as an editable pin can bound its UI to the
 * same limit the compiled loop actually enforces.
 */
export const FX_FBM_MAX_OCTAVES = 8;

/**
 * `fbm`'s two helpers are each fully self-contained (their own private 1D value-noise sampler,
 * under names - `fxFbmHash1`/`fxFbmNoise1` - that can't collide with `noise`'s `fxIntHash1`/
 * `fxHash1`). Deliberate, not an oversight: `fn.call("fbm", ...)` only auto-emits `fbm`'s own
 * helper (keyed by its own name); if this text instead called into `noise`'s separately-keyed
 * helper, that helper would only be present when some OTHER call in the same graph happens to also
 * pull it in - self-containment is what lets `fbm` work as an ordinary, tier-transparent registry
 * function with no extra wiring, the same as everything else in this file.
 */
export const FX_FBM_JS_HELPER = `
function fxFbmHash1(n){
  var shifted=(n<<13)|0;
  var mixed=(shifted^n)|0;
  var squared=Math.imul(mixed,mixed);
  var step1=(Math.imul(squared,15731)+Math.imul(mixed,789221))|0;
  var step2=(Math.imul(step1,step1)+1376312589)|0;
  return (step2&0x00ffffff)/16777216.0;
}
function fxFbmNoise1(x){
  var i=Math.floor(x);
  var f=x-i;
  var u=f*f*(3-2*f);
  return (fxFbmHash1(i)*(1-u)+fxFbmHash1(i+1)*u)*2-1;
}
function fxFbm(x, octaves) {
  var n = Math.min(Math.max(Math.floor(octaves), 0), ${FX_FBM_MAX_OCTAVES.toString()});
  var sum = 0, amp = 1, freq = 1;
  for (var o = 0; o < n; o++) {
    sum += fxFbmNoise1(x * freq) * amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum;
}`;

const FX_FBM_GLSL_STANDARD_HELPER = `
float fxFbmHash1(int n){
  int shifted=n<<13;
  int mixed=shifted^n;
  int squared=mixed*mixed;
  int step1=squared*15731+mixed*789221;
  int step2=step1*step1+1376312589;
  int masked=step2&0x00ffffff;
  return float(masked)/16777216.0;
}
float fxFbmNoise1(float x){
  int i=int(floor(x));
  float f=x-floor(x);
  float u=f*f*(3.0-2.0*f);
  return (fxFbmHash1(i)*(1.0-u)+fxFbmHash1(i+1)*u)*2.0-1.0;
}
float fxFbm(float x, float octaves){
  int n=int(clamp(floor(octaves),0.0,${FX_FBM_MAX_OCTAVES.toString()}.0));
  float sum=0.0;
  float amp=1.0;
  float freq=1.0;
  for(int o=0;o<n;o++){
    sum+=fxFbmNoise1(x*freq)*amp;
    amp*=0.5;
    freq*=2.0;
  }
  return sum;
}`;

/**
 * 3D-domain twin of {@link FX_FBM_JS_HELPER}: samples the full input position every octave
 * (via a self-contained `fxFbm3Noise3`, structurally identical to `noise`'s `fxNoise3` but under
 * its own private names for the same self-containment reason `fbm` needs one) instead of a single
 * scalar axis - so the field genuinely varies across all three input components, not just one.
 */
export const FX_FBM3_JS_HELPER = `
function fxFbm3Hash1(n){
  var shifted=(n<<13)|0;
  var mixed=(shifted^n)|0;
  var squared=Math.imul(mixed,mixed);
  var step1=(Math.imul(squared,15731)+Math.imul(mixed,789221))|0;
  var step2=(Math.imul(step1,step1)+1376312589)|0;
  return (step2&0x00ffffff)/16777216.0;
}
function fxFbm3Hash3(ix,iy,iz){return fxFbm3Hash1((ix+Math.imul(iy,57)+Math.imul(iz,113))|0);}
function fxFbm3Noise3(vx,vy,vz){
  var ix=Math.floor(vx),iy=Math.floor(vy),iz=Math.floor(vz);
  var fx=vx-ix,fy=vy-iy,fz=vz-iz;
  var ux=fx*fx*(3-2*fx),uy=fy*fy*(3-2*fy),uz=fz*fz*(3-2*fz);
  var a=fxFbm3Hash3(ix,iy,iz),b=fxFbm3Hash3(ix+1,iy,iz);
  var c=fxFbm3Hash3(ix,iy+1,iz),d=fxFbm3Hash3(ix+1,iy+1,iz);
  var e=fxFbm3Hash3(ix,iy,iz+1),f=fxFbm3Hash3(ix+1,iy,iz+1);
  var g=fxFbm3Hash3(ix,iy+1,iz+1),h=fxFbm3Hash3(ix+1,iy+1,iz+1);
  var ab=a+(b-a)*ux,cd=c+(d-c)*ux,abcd=ab+(cd-ab)*uy;
  var ef=e+(f-e)*ux,gh=g+(h-g)*ux,efgh=ef+(gh-ef)*uy;
  return (abcd+(efgh-abcd)*uz)*2-1;
}
function fxFbm3(vx, vy, vz, octaves) {
  var n = Math.min(Math.max(Math.floor(octaves), 0), ${FX_FBM_MAX_OCTAVES.toString()});
  var sum = 0, amp = 1, freq = 1;
  for (var o = 0; o < n; o++) {
    sum += fxFbm3Noise3(vx * freq, vy * freq, vz * freq) * amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum;
}`;

const FX_FBM3_GLSL_STANDARD_HELPER = `
float fxFbm3Hash1(int n){
  int shifted=n<<13;
  int mixed=shifted^n;
  int squared=mixed*mixed;
  int step1=squared*15731+mixed*789221;
  int step2=step1*step1+1376312589;
  int masked=step2&0x00ffffff;
  return float(masked)/16777216.0;
}
float fxFbm3Hash3(int ix,int iy,int iz){return fxFbm3Hash1(ix+iy*57+iz*113);}
float fxFbm3Noise3(vec3 p){
  vec3 i=floor(p);
  vec3 f=p-i;
  vec3 u=f*f*(3.0-2.0*f);
  int ix=int(i.x);
  int iy=int(i.y);
  int iz=int(i.z);
  float a=fxFbm3Hash3(ix,iy,iz);
  float b=fxFbm3Hash3(ix+1,iy,iz);
  float c=fxFbm3Hash3(ix,iy+1,iz);
  float d=fxFbm3Hash3(ix+1,iy+1,iz);
  float e=fxFbm3Hash3(ix,iy,iz+1);
  float f2=fxFbm3Hash3(ix+1,iy,iz+1);
  float g=fxFbm3Hash3(ix,iy+1,iz+1);
  float h=fxFbm3Hash3(ix+1,iy+1,iz+1);
  return (mix(mix(mix(a,b,u.x),mix(c,d,u.x),u.y),mix(mix(e,f2,u.x),mix(g,h,u.x),u.y),u.z))*2.0-1.0;
}
float fxFbm3(vec3 p, float octaves){
  int n=int(clamp(floor(octaves),0.0,${FX_FBM_MAX_OCTAVES.toString()}.0));
  float sum=0.0;
  float amp=1.0;
  float freq=1.0;
  for(int o=0;o<n;o++){
    sum+=fxFbm3Noise3(p*freq)*amp;
    amp*=0.5;
    freq*=2.0;
  }
  return sum;
}`;

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

  // Value noise, 1D/2D/3D: vector-in/scalar-out, so (like the reductions) it is NOT element-wise;
  // the scalarizer splits the vector arg and re-emits a scalar `noise` call, printed as
  // fxNoise1/2/3 by arity. GLSL overloads `noise(...)` by argument type (baseline: sin-hash,
  // standard: integer-hash - see the two helpers above); JS always uses the integer-hash form
  // (symmetric with `glslStandard`, since JS has none of ES-1.00's bitwise/int restrictions).
  definitions.push({
    name: "noise",
    signatures: [
      { args: ["float"], result: "float" },
      { args: ["vec2"], result: "float" },
      { args: ["vec3"], result: "float" },
    ],
    glslBaselineHelper: FX_NOISE_GLSL_BASELINE_HELPER,
    glslStandardHelper: FX_NOISE_GLSL_STANDARD_HELPER,
    jsHelper: FX_NOISE_JS_HELPER,
    js: (args) =>
      args.length === 1
        ? `fxNoise1(${args[0]})`
        : args.length === 2
          ? `fxNoise2(${args[0]}, ${args[1]})`
          : `fxNoise3(${args[0]}, ${args[1]}, ${args[2]})`,
  });

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

  // Fractal Brownian motion over 1D value noise (gain 0.5, lacunarity 2), `octaves` a runtime
  // argument. `standardOnly`: no baseline-tier form exists (nothing calls it under that tier yet).
  definitions.push({
    name: "fbm",
    signatures: [{ args: ["float", "float"], result: "float" }],
    standardOnly: true,
    jsHelper: FX_FBM_JS_HELPER,
    glslStandardHelper: FX_FBM_GLSL_STANDARD_HELPER,
    js: (args) => `fxFbm(${args[0]}, ${args[1]})`,
    glslStandard: (args) => `fxFbm(${args[0]}, ${args[1]})`,
  });

  // 3D-domain twin of `fbm`: vector-in/scalar-out like `noise`, so the scalarizer flattens the
  // `vec3` arg into separate scalar args for JS (see the "fbm3" case in `scalarize.Internal.ts`);
  // GLSL keeps the native `vec3` arg, since GLSL has real vector types. `standardOnly`: same reason
  // as `fbm` - no baseline-tier form exists yet.
  definitions.push({
    name: "fbm3",
    signatures: [{ args: ["vec3", "float"], result: "float" }],
    standardOnly: true,
    jsHelper: FX_FBM3_JS_HELPER,
    glslStandardHelper: FX_FBM3_GLSL_STANDARD_HELPER,
    js: (args) => `fxFbm3(${args[0]}, ${args[1]}, ${args[2]}, ${args[3]})`,
    glslStandard: (args) => `fxFbm3(${args[0]}, ${args[1]})`,
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
