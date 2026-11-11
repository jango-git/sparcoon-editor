import type { FXHelperModule } from "../FXHelperModule.Internal";

/**
 * Hashes behind every noise helper:
 * - baseline GLSL: float hashes (ES 1.00 has no bitwise ops or guaranteed 32-bit ints);
 * - standard GLSL and JS: PCG (Jarzynski & Olano 2020), bit-identical so a GPU behavior kernel
 *   and its JS twin agree.
 * Noise sources and the seed hash reach a hash only through this file, so swapping one touches
 * nothing else.
 */

/**
 * Per-axis lattice multipliers (Teschner et al.); a cell's hash input is `x*P0 ^ y*P1 ^ z*P2`
 * (`fxLattice` in GLSL; value noise precomputes the per-axis products instead).
 */
export const FX_LATTICE_PRIMES = [73856093, 19349663, 83492791] as const;

type Offset = 0 | 1;

/** Component count of a seed hash's result. */
export type FXSeedHashComponents = 1 | 2 | 3 | 4;

/** How a GLSL tier hashes lattice points, Voronoi cells and seeds, as source snippets. */
export interface FXGLSLNoiseHash {
  readonly module: FXHelperModule;
  /** Statements run once per sample, given the cell origin `fl` (float/vecN). */
  readonly latticeSetup: (dimensions: 1 | 2 | 3) => string;
  /** [0, 1) hash of the lattice corner `fl + offset`. */
  readonly corner: (offset: readonly Offset[]) => string;
  readonly voronoi: FXGLSLVoronoiHash;
  /** Body returning `components` independent [0, 1) values of the point `vec3 s` and `float salt`. */
  readonly seed: (components: FXSeedHashComponents) => string;
}

/**
 * Voronoi cell hashing over a search window at `base`, visited with loop counters `ox`, `oy`
 * (, `oz`) and offset `o`. Each cell yields a jitter `h` and a token `t`; the winning cell's
 * token becomes its id.
 */
export interface FXGLSLVoronoiHash {
  /** Statements run once per sample. */
  readonly setup: (dimensions: 2 | 3) => string;
  /** Statements declaring `vecN h` (jitter in [0, 1)) and `t` for the current cell. */
  readonly cell: (dimensions: 2 | 3) => string;
  /** Type and initial value of a token variable. */
  readonly token: (dimensions: 2 | 3) => { readonly type: string; readonly zero: string };
  /** [0, 1) id of the cell with token `token`. */
  readonly cellValue: (dimensions: 2 | 3, token: string) => string;
}

const BASELINE_HASH_MODULE: FXHelperModule = {
  key: "fxHash",
  source: `
float fxHash1(float n){float s=sin(n*127.1)*43758.5453123;return s-floor(s);}
float fxHash2(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float fxHash3(vec3 p){p=fract(p*vec3(443.897,441.423,437.195));p+=dot(p,p.yzx+19.19);return fract((p.x+p.y)*p.z);}
vec2 fxHash22(vec2 p){vec3 q=fract(p.xyx*vec3(0.1031,0.1030,0.0973));q+=dot(q,q.yzx+33.33);return fract((q.xx+q.yz)*q.zy);}
vec3 fxHash33(vec3 p){p=fract(p*vec3(0.1031,0.1030,0.0973));p+=dot(p,p.yxz+33.33);return fract((p.xxy+p.yxx)*p.zyx);}
vec4 fxHash44(vec4 p){p=fract(p*vec4(0.1031,0.1030,0.0973,0.1099));p+=dot(p,p.wzxy+33.33);return fract((p.xxyz+p.yzzw)*p.zywx);}`,
};

function floatVector(offset: readonly Offset[]): string {
  return offset.length === 1
    ? `${offset.join("")}.0`
    : `vec${offset.length.toString()}(${offset.map((o) => `${o.toString()}.0`).join(",")})`;
}

export const FX_GLSL_BASELINE_NOISE_HASH: FXGLSLNoiseHash = {
  module: BASELINE_HASH_MODULE,
  latticeSetup: () => "",
  corner: (offset) => `fxHash${offset.length.toString()}(fl+${floatVector(offset)})`,
  // The token is the cell itself; its id is hashed once, for the winner only.
  voronoi: {
    setup: () => "",
    cell: (dimensions) => {
      const type = `vec${dimensions.toString()}`;
      return `${type} t=base+o;${type} h=fxHash${dimensions.toString()}${dimensions.toString()}(t);`;
    },
    token: (dimensions) => ({
      type: `vec${dimensions.toString()}`,
      zero: `vec${dimensions.toString()}(0.0)`,
    }),
    cellValue: (dimensions, token) => `fxHash${dimensions.toString()}(${token})`,
  },
  // The salt is the fourth coordinate.
  seed: (components) => `return fxHash44(vec4(s,salt)).${"xyzw".slice(0, components)};`,
};

const P0 = `${FX_LATTICE_PRIMES[0].toString()}u`;
const P1 = `${FX_LATTICE_PRIMES[1].toString()}u`;
const P2 = `${FX_LATTICE_PRIMES[2].toString()}u`;
const UNIT = "5.9604644775390625e-8"; // 2^-24: the top 24 bits map exactly onto float's mantissa
// Voronoi jitter splits one 32-bit hash: 2D into 16 + 16 bits, 3D into 10 + 11 + 11.
const UNIT_16 = "1.52587890625e-5"; // 2^-16
const UNIT_11 = "4.8828125e-4"; // 2^-11
const UNIT_10 = "9.765625e-4"; // 2^-10
/** Odd multiplier remixing a cell's hash into its id, decorrelated from the jitter bits. */
const ID_MIX = 2654435769;

const STANDARD_HASH_MODULE: FXHelperModule = {
  key: "fxHash",
  source: `
uint fxPcg(uint v){uint s=v*747796405u+2891336453u;uint w=((s>>((s>>28u)+4u))^s)*277803737u;return (w>>22u)^w;}
float fxUnit(uint h){return float(h>>8u)*${UNIT};}
vec2 fxUnit2(uint h){return vec2(h>>16u,h&65535u)*${UNIT_16};}
vec3 fxUnit3(uint h){return vec3(h>>22u,(h>>11u)&2047u,h&2047u)*vec3(${UNIT_10},${UNIT_11},${UNIT_11});}
uint fxLattice(uvec3 c){return c.x*${P0}^c.y*${P1}^c.z*${P2};}`,
};

const STANDARD_PRIMES = [P0, P1, P2];

export const FX_GLSL_STANDARD_NOISE_HASH: FXGLSLNoiseHash = {
  module: STANDARD_HASH_MODULE,
  // `l0`/`l1`: the cell's per-axis products for offsets 0 and 1, so each corner is one xor.
  latticeSetup: (dimensions) => {
    if (dimensions === 1) {
      return "uint l0=uint(int(fl));uint l1=l0+1u;";
    }
    const vector = `uvec${dimensions.toString()}`;
    const primes = `${vector}(${STANDARD_PRIMES.slice(0, dimensions).join(",")})`;
    return `${vector} l0=${vector}(ivec${dimensions.toString()}(fl))*${primes};${vector} l1=l0+${primes};`;
  },
  corner: (offset) =>
    offset.length === 1
      ? `fxUnit(fxPcg(l${offset.join("")}))`
      : `fxUnit(fxPcg(${offset.map((o, axis) => `l${o.toString()}.${"xyz"[axis]}`).join("^")}))`,
  // Per-axis products of the window origin; a cell adds its offset's multiple, so each cell costs
  // one xor and one PCG. The token is the cell's 32-bit hash: its remix is the id.
  voronoi: {
    setup: (dimensions) => {
      const vector = `uvec${dimensions.toString()}`;
      const primes = `${vector}(${STANDARD_PRIMES.slice(0, dimensions).join(",")})`;
      return `${vector} l=${vector}(ivec${dimensions.toString()}(base))*${primes};`;
    },
    cell: (dimensions) => {
      const terms = (["x", "y", "z"] as const)
        .slice(0, dimensions)
        .map((axis, i) => `(l.${axis}+uint(o${axis})*${STANDARD_PRIMES[i] ?? P0})`)
        .join("^");
      return `uint t=fxPcg(${terms});vec${dimensions.toString()} h=fxUnit${dimensions.toString()}(t);`;
    },
    token: () => ({ type: "uint", zero: "0u" }),
    cellValue: (_dimensions, token) => `fxUnit(${token}*${ID_MIX.toString()}u)`,
  },
  // The seed's bits are its lattice point; each further component is one more PCG round.
  seed: (components) => {
    const rounds = Array.from(
      { length: components - 1 },
      (_, i) => `uint h${(i + 1).toString()}=fxPcg(h${i.toString()});`,
    ).join("");
    const units = Array.from({ length: components }, (_, i) => `fxUnit(h${i.toString()})`);
    const result = components === 1 ? units[0] : `vec${components.toString()}(${units.join(",")})`;
    return `uint h0=fxPcg(fxLattice(floatBitsToUint(s))^fxPcg(floatBitsToUint(salt)));${rounds}return ${result};`;
  },
};

/** `Math.imul` and `|0`/`>>>0` reproduce uint32 wraparound, matching the standard GLSL. */
export const FX_JS_NOISE_HASH: FXHelperModule = {
  key: "fxHash",
  source: `
function fxPcg(v){var s=(Math.imul(v,747796405)+2891336453)>>>0;var w=Math.imul((s>>>((s>>>28)+4))^s,277803737);return ((w>>>22)^w)>>>0;}
function fxUnit(h){return (h>>>8)*${UNIT};}`,
};

/** JS spellings of the Voronoi jitter split and id remix (see {@link FXGLSLVoronoiHash}). */
export const FX_JS_VORONOI_BITS = {
  unit16: UNIT_16,
  unit11: UNIT_11,
  unit10: UNIT_10,
  idMix: ID_MIX.toString(),
} as const;
