import type { FXHelperModule } from "../FXHelperModule.Internal";
import {
  FX_GLSL_BASELINE_NOISE_HASH,
  FX_GLSL_STANDARD_NOISE_HASH,
  FX_JS_NOISE_HASH,
  FX_LATTICE_PRIMES,
  type FXGLSLNoiseHash,
} from "./FXNoiseHash.Internal";

/**
 * Value noise in [-1, 1]: cell-corner hashes blended with smoothstep weights.
 * - `noise` / `fxNoise1..3`: the value;
 * - `fxNoised` / `fxNoised2..3`: value and analytic gradient, so curl needs one sample per
 *   potential instead of a central difference per axis.
 * One GLSL template serves both tiers; only the corner hash differs.
 */

type Dimensions = 1 | 2 | 3;
type Offset = 0 | 1;

const GLSL_TYPES = { 1: "float", 2: "vec2", 3: "vec3" } as const;

/** Corner offsets in index order (bit 0 = x, bit 1 = y, bit 2 = z). */
function cornerOffsets(dimensions: Dimensions): Offset[][] {
  return Array.from({ length: 1 << dimensions }, (_, index) =>
    Array.from({ length: dimensions }, (_unused, axis) => ((index >> axis) & 1) as Offset),
  );
}

/** Shared prologue: cell origin `fl`, fraction `f`, smoothstep weight `u`, corners `c0..`. */
function cellPrologue(hash: FXGLSLNoiseHash, dimensions: Dimensions): string {
  const type = GLSL_TYPES[dimensions];
  const corners = cornerOffsets(dimensions)
    .map((offset, index) => `float c${index.toString()}=${hash.corner(offset)};`)
    .join("");
  return `${type} fl=floor(p);${type} f=p-fl;${type} u=f*f*(3.0-2.0*f);${hash.latticeSetup(dimensions)}${corners}`;
}

const BLEND = {
  1: "mix(c0,c1,u)",
  2: "mix(mix(c0,c1,u.x),mix(c2,c3,u.x),u.y)",
  3: "mix(mix(mix(c0,c1,u.x),mix(c2,c3,u.x),u.y),mix(mix(c4,c5,u.x),mix(c6,c7,u.x),u.y),u.z)",
} as const;

function glslNoiseModule(hash: FXGLSLNoiseHash): FXHelperModule {
  const overloads = ([1, 2, 3] as const).map(
    (dimensions) =>
      `float noise(${GLSL_TYPES[dimensions]} p){${cellPrologue(hash, dimensions)}return ${BLEND[dimensions]}*2.0-1.0;}`,
  );
  return { key: "noise", source: `\n${overloads.join("\n")}`, requires: [hash.module] };
}

// Trilinear blend expanded into polynomial coefficients k (Inigo Quilez's formulation): the value
// is a polynomial in u, and d(value)/dp = du * d(value)/du with du = 6f(1-f).
function glslNoisedModule(hash: FXGLSLNoiseHash): FXHelperModule {
  const noised2 =
    `vec3 fxNoised(vec2 p){${cellPrologue(hash, 2)}vec2 du=6.0*f*(1.0-f);` +
    "float k1=c1-c0;float k2=c2-c0;float k3=c0-c1-c2+c3;" +
    "float v=c0+k1*u.x+k2*u.y+k3*u.x*u.y;" +
    "vec2 g=du*vec2(k1+k3*u.y,k2+k3*u.x);" +
    "return vec3(v*2.0-1.0,g*2.0);}";
  const noised3 =
    `vec4 fxNoised(vec3 p){${cellPrologue(hash, 3)}vec3 du=6.0*f*(1.0-f);` +
    "float k1=c1-c0;float k2=c2-c0;float k3=c4-c0;" +
    "float k4=c0-c1-c2+c3;float k5=c0-c2-c4+c6;float k6=c0-c1-c4+c5;" +
    "float k7=-c0+c1+c2-c3+c4-c5-c6+c7;" +
    "float v=c0+k1*u.x+k2*u.y+k3*u.z+k4*u.x*u.y+k5*u.y*u.z+k6*u.z*u.x+k7*u.x*u.y*u.z;" +
    "vec3 g=du*vec3(k1+k4*u.y+k6*u.z+k7*u.y*u.z,k2+k5*u.z+k4*u.x+k7*u.z*u.x,k3+k6*u.x+k5*u.y+k7*u.x*u.y);" +
    "return vec4(v*2.0-1.0,g*2.0);}";
  return { key: "fxNoised", source: `\n${noised2}\n${noised3}`, requires: [hash.module] };
}

export const FX_GLSL_BASELINE_NOISE = glslNoiseModule(FX_GLSL_BASELINE_NOISE_HASH);
export const FX_GLSL_STANDARD_NOISE = glslNoiseModule(FX_GLSL_STANDARD_NOISE_HASH);
export const FX_GLSL_BASELINE_NOISED = glslNoisedModule(FX_GLSL_BASELINE_NOISE_HASH);
export const FX_GLSL_STANDARD_NOISED = glslNoisedModule(FX_GLSL_STANDARD_NOISE_HASH);

/**
 * Approximate op counts of one call by coordinate width, hand-counted from the standard-tier
 * source (baseline lands in the same range). Kept beside the source they describe.
 */
export const FX_NOISE_CALL_COST: Readonly<Record<number, number>> = { 1: 35, 2: 79, 3: 151 };
export const FX_NOISED_CALL_COST: Readonly<Record<number, number>> = { 2: 91, 3: 190 };

const JS_AXES = ["x", "y", "z"] as const;
/** 1D hashes the raw cell index, as the standard GLSL 1D setup does. */
const JS_PRIMES: Readonly<Record<Dimensions, readonly number[]>> = {
  1: [1],
  2: FX_LATTICE_PRIMES.slice(0, 2),
  3: FX_LATTICE_PRIMES,
};

/**
 * Mirrors the standard GLSL prologue: per axis `a` the fraction `ta`, weight `ua` and the
 * per-axis products `a0`/`a1`, then corners `c0..`.
 */
function jsPrologue(dimensions: Dimensions): string {
  const axes = JS_AXES.slice(0, dimensions);
  const perAxis = axes
    .map((axis, i) => {
      const prime = JS_PRIMES[dimensions][i]?.toString() ?? "1";
      return (
        `var f${axis}=Math.floor(${axis}),t${axis}=${axis}-f${axis},u${axis}=t${axis}*t${axis}*(3-2*t${axis});` +
        `var ${axis}0=Math.imul(f${axis}|0,${prime}),${axis}1=(${axis}0+${prime})|0;`
      );
    })
    .join("");
  const corners = cornerOffsets(dimensions)
    .map(
      (offset, index) =>
        `var c${index.toString()}=fxUnit(fxPcg(${offset.map((o, axis) => `${JS_AXES[axis]}${o.toString()}`).join("^")}));`,
    )
    .join("");
  return perAxis + corners;
}

const JS_BLEND = {
  1: "return (c0+(c1-c0)*ux)*2-1;",
  2: "var a=c0+(c1-c0)*ux,b=c2+(c3-c2)*ux;return (a+(b-a)*uy)*2-1;",
  3:
    "var a=c0+(c1-c0)*ux,b=c2+(c3-c2)*ux,c=c4+(c5-c4)*ux,d=c6+(c7-c6)*ux;" +
    "var ab=a+(b-a)*uy,cd=c+(d-c)*uy;return (ab+(cd-ab)*uz)*2-1;",
} as const;

function jsNoise(dimensions: Dimensions): string {
  const args = JS_AXES.slice(0, dimensions).join(",");
  return `function fxNoise${dimensions.toString()}(${args}){${jsPrologue(dimensions)}${JS_BLEND[dimensions]}}`;
}

export const FX_JS_NOISE: FXHelperModule = {
  key: "noise",
  requires: [FX_JS_NOISE_HASH],
  source: `\n${([1, 2, 3] as const).map(jsNoise).join("\n")}`,
};

/** `fxNoised*` write value and gradient to `fxNd0..3`; same polynomial form as the GLSL. */
export const FX_JS_NOISED: FXHelperModule = {
  key: "fxNoised",
  requires: [FX_JS_NOISE_HASH],
  source: `
var fxNd0=0,fxNd1=0,fxNd2=0,fxNd3=0;
function fxNoised2(x,y){${jsPrologue(2)}
  var dx=6*tx*(1-tx),dy=6*ty*(1-ty);
  var k1=c1-c0,k2=c2-c0,k3=c0-c1-c2+c3;
  fxNd0=(c0+k1*ux+k2*uy+k3*ux*uy)*2-1;
  fxNd1=dx*(k1+k3*uy)*2;fxNd2=dy*(k2+k3*ux)*2;
}
function fxNoised3(x,y,z){${jsPrologue(3)}
  var dx=6*tx*(1-tx),dy=6*ty*(1-ty),dz=6*tz*(1-tz);
  var k1=c1-c0,k2=c2-c0,k3=c4-c0,k4=c0-c1-c2+c3,k5=c0-c2-c4+c6,k6=c0-c1-c4+c5,k7=-c0+c1+c2-c3+c4-c5-c6+c7;
  fxNd0=(c0+k1*ux+k2*uy+k3*uz+k4*ux*uy+k5*uy*uz+k6*uz*ux+k7*ux*uy*uz)*2-1;
  fxNd1=dx*(k1+k4*uy+k6*uz+k7*uy*uz)*2;
  fxNd2=dy*(k2+k5*uz+k4*ux+k7*uz*ux)*2;
  fxNd3=dz*(k3+k6*ux+k5*uy+k7*ux*uy)*2;
}`,
};
