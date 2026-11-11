import type { FXHelperModule } from "../FXHelperModule.Internal";
import {
  FX_JS_NOISE_HASH,
  FX_JS_VORONOI_BITS,
  FX_LATTICE_PRIMES,
  type FXGLSLNoiseHash,
} from "./FXNoiseHash.Internal";
import { jsMemoized } from "./FXNoiseJSMemo.Internal";

/**
 * Voronoi noise: one feature point per cell at `cell + 0.5 + jitter * (h - 0.5)`; the result is
 * `(F1, F2, cellId)` - nearest and second-nearest distance, and a [0, 1) value of F1's cell.
 * - `fast` searches the 2^N cells whose centers surround `p` (Gustavson's window). F1 and the id
 *   are exact up to jitter 0.5 (~0.1% of samples off at 0.8). F2 often lies outside the window:
 *   at jitter 0.8 ~8% of F2/edge samples are wrong, with seams along the window grid.
 * - `full` searches the 3^N cells around `p`'s cell: F1, F2 and edge exact in practice.
 * Per cell: one PCG of the window's per-axis products, split into jitter bits; the winner's
 * hash, remixed, is the id. F1/F2 update branch-free; euclidean compares squared distances.
 */

export const FX_VORONOI_QUALITIES = ["fast", "full"] as const;
export const FX_VORONOI_METRICS = ["euclidean", "manhattan", "chebyshev"] as const;

export type FXVoronoiQuality = (typeof FX_VORONOI_QUALITIES)[number];
export type FXVoronoiMetric = (typeof FX_VORONOI_METRICS)[number];

export interface FXVoronoiVariant {
  readonly quality: FXVoronoiQuality;
  readonly metric: FXVoronoiMetric;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** The registry function name of a variant, e.g. `voronoiFastEuclidean`. */
export function voronoiFunctionName(variant: FXVoronoiVariant): string {
  return `voronoi${capitalize(variant.quality)}${capitalize(variant.metric)}`;
}

/** The JS twin's integer codes for a variant - its trailing arguments before the component. */
export function voronoiJSCodes(variant: FXVoronoiVariant): readonly [number, number] {
  return [
    FX_VORONOI_QUALITIES.indexOf(variant.quality),
    FX_VORONOI_METRICS.indexOf(variant.metric),
  ];
}

const AXES = ["x", "y", "z"] as const;

function glslMetric(metric: FXVoronoiMetric, dimensions: 2 | 3): string {
  const type = `vec${dimensions.toString()}`;
  switch (metric) {
    case "euclidean":
      return "dot(r,r)";
    case "manhattan":
      return `dot(abs(r),${type}(1.0))`;
    case "chebyshev":
      return dimensions === 2 ? "max(abs(r.x),abs(r.y))" : "max(max(abs(r.x),abs(r.y)),abs(r.z))";
  }
}

function glslVoronoi(
  hash: FXGLSLNoiseHash,
  variant: FXVoronoiVariant,
  name: string,
  dimensions: 2 | 3,
): string {
  const type = `vec${dimensions.toString()}`;
  const span = variant.quality === "fast" ? "2" : "3";
  const base = variant.quality === "fast" ? "floor(p-0.5)" : "floor(p)-1.0";
  const axes = AXES.slice(0, dimensions);
  const loops = axes
    .slice()
    .reverse()
    .map((axis) => `for(int o${axis}=0;o${axis}<${span};o${axis}++){`)
    .join("");
  const offset = `${type}(${axes.map((axis) => `float(o${axis})`).join(",")})`;
  const finish = variant.metric === "euclidean" ? "f1=sqrt(f1);f2=sqrt(f2);" : "";
  const token = hash.voronoi.token(dimensions);
  // r = o + 0.5 + j*(h - 0.5) - f, with the per-sample part folded into `c`.
  return (
    `vec3 ${name}(${type} p,float j){${type} base=${base};${type} c=0.5-0.5*j-(p-base);` +
    `${hash.voronoi.setup(dimensions)}float f1=1e4;float f2=1e4;${token.type} best=${token.zero};${loops}` +
    `${type} o=${offset};${hash.voronoi.cell(dimensions)}${type} r=o+c+j*h;` +
    `float d=${glslMetric(variant.metric, dimensions)};` +
    "best=d<f1?t:best;f2=min(f2,max(f1,d));f1=min(f1,d);" +
    "}".repeat(dimensions) +
    `${finish}return vec3(f1,f2,${hash.voronoi.cellValue(dimensions, "best")});}`
  );
}

/** One variant's GLSL module: a vec2 and a vec3 overload, keyed by the function name. */
export function glslVoronoiModule(
  hash: FXGLSLNoiseHash,
  variant: FXVoronoiVariant,
): FXHelperModule {
  const glslName = voronoiGLSLName(variant);
  return {
    key: voronoiFunctionName(variant),
    source: `\n${glslVoronoi(hash, variant, glslName, 2)}\n${glslVoronoi(hash, variant, glslName, 3)}`,
    requires: [hash.module],
  };
}

/** The GLSL function a variant prints as. */
export function voronoiGLSLName(variant: FXVoronoiVariant): string {
  return `fx${capitalize(voronoiFunctionName(variant))}`;
}

/** Approximate op counts of one call, by quality and coordinate width (standard tier). */
export const FX_VORONOI_CALL_COST: Readonly<
  Record<FXVoronoiQuality, Readonly<Record<number, number>>>
> = {
  fast: { 2: 132, 3: 314 },
  full: { 2: 272, 3: 1000 },
};

const [P0, P1, P2] = [
  FX_LATTICE_PRIMES[0].toString(),
  FX_LATTICE_PRIMES[1].toString(),
  FX_LATTICE_PRIMES[2].toString(),
];
const BITS = FX_JS_VORONOI_BITS;

/**
 * `fxVoronoiSearch(r, d, x, y, z, jitter, quality, metric)` writes `(F1, F2, cellId)` to `r`; 2D
 * passes `z = 0` and never reads it. Mirrors the standard GLSL op for op. Codes from
 * {@link voronoiJSCodes}.
 */
const JS_VORONOI_SEARCH = `
function fxVoronoiSearch(r,d,x,y,z,j,q,m){
  var s=q===0?2:3,sz=d===3?s:1;
  var bx=q===0?Math.floor(x-0.5):Math.floor(x)-1,by=q===0?Math.floor(y-0.5):Math.floor(y)-1;
  var bz=d===2?0:q===0?Math.floor(z-0.5):Math.floor(z)-1;
  var cx=0.5-0.5*j-(x-bx),cy=0.5-0.5*j-(y-by),cz=0.5-0.5*j-(z-bz);
  var lx=Math.imul(bx|0,${P0}),ly=Math.imul(by|0,${P1}),lz=d===3?Math.imul(bz|0,${P2}):0;
  var f1=1e4,f2=1e4,best=0;
  for(var oz=0;oz<sz;oz++){var tz=d===3?(lz+Math.imul(oz,${P2}))|0:0;
  for(var oy=0;oy<s;oy++){var ty=(ly+Math.imul(oy,${P1}))|0;
  for(var ox=0;ox<s;ox++){
    var t=fxPcg(((lx+Math.imul(ox,${P0}))|0)^ty^tz),hx,hy,rz=0;
    if(d===2){hx=(t>>>16)*${BITS.unit16};hy=(t&65535)*${BITS.unit16};}
    else{hx=(t>>>22)*${BITS.unit10};hy=((t>>>11)&2047)*${BITS.unit11};rz=oz+cz+j*((t&2047)*${BITS.unit11});}
    var rx=ox+cx+j*hx,ry=oy+cy+j*hy;
    var dist=m===0?rx*rx+ry*ry+rz*rz:m===1?Math.abs(rx)+Math.abs(ry)+Math.abs(rz):Math.max(Math.abs(rx),Math.abs(ry),Math.abs(rz));
    if(dist<f1){best=t;}f2=Math.min(f2,Math.max(f1,dist));f1=Math.min(f1,dist);
  }}}
  if(m===0){f1=Math.sqrt(f1);f2=Math.sqrt(f2);}
  r[0]=f1;r[1]=f2;r[2]=fxUnit(Math.imul(best,${BITS.idMix}));
}`;

/** `fxVoronoi2(x, y, jitter, quality, metric, component)` and its 3D sibling. */
export const FX_JS_VORONOI: FXHelperModule = {
  key: "voronoi",
  requires: [FX_JS_NOISE_HASH],
  source: [
    JS_VORONOI_SEARCH,
    jsMemoized("fxVoronoi2", ["x", "y", "j", "q", "m"], 3, "fxVoronoiSearch(r,2,x,y,0,j,q,m);"),
    jsMemoized(
      "fxVoronoi3",
      ["x", "y", "z", "j", "q", "m"],
      3,
      "fxVoronoiSearch(r,3,x,y,z,j,q,m);",
    ),
  ].join("\n"),
};
