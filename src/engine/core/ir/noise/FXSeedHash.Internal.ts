import type { FXHelperModule } from "../FXHelperModule.Internal";
import {
  FX_JS_NOISE_HASH,
  FX_LATTICE_PRIMES,
  type FXGLSLNoiseHash,
  type FXSeedHashComponents,
} from "./FXNoiseHash.Internal";
import { jsMemoized } from "./FXNoiseJSMemo.Internal";

/**
 * Seed hash: 1-4 independent [0, 1) values of a float point and a salt - a stable random per
 * particle id, uv or attribute. Unlike the noise lattice it hashes the float's bits, not its cell,
 * so any two distinct seeds decorrelate. One GLSL template serves both tiers.
 */

export const FX_SEED_HASH_COMPONENTS: readonly FXSeedHashComponents[] = [1, 2, 3, 4];

/** The registry function name for a result width, e.g. `seedHash3`. */
export function seedHashFunctionName(components: FXSeedHashComponents): string {
  return `seedHash${components.toString()}`;
}

/** The GLSL function a width prints as. */
export function seedHashGLSLName(components: FXSeedHashComponents): string {
  return `fxSeedHash${components.toString()}`;
}

/** The result type of each width. */
export const FX_SEED_HASH_TYPES = { 1: "float", 2: "vec2", 3: "vec3", 4: "vec4" } as const;

export function glslSeedHashModule(hash: FXGLSLNoiseHash): FXHelperModule {
  const overloads = FX_SEED_HASH_COMPONENTS.map(
    (components) =>
      `${FX_SEED_HASH_TYPES[components]} ${seedHashGLSLName(components)}(vec3 s,float salt){${hash.seed(components)}}`,
  );
  return { key: "seedHash", source: `\n${overloads.join("\n")}`, requires: [hash.module] };
}

/**
 * Approximate op counts of one call by result width (standard tier: the key's three products,
 * xors and two PCG rounds, then a PCG round and a unit per further component).
 */
export const FX_SEED_HASH_CALL_COST: Readonly<Record<FXSeedHashComponents, number>> = {
  1: 24,
  2: 34,
  3: 44,
  4: 54,
};

const [P0, P1, P2] = FX_LATTICE_PRIMES.map(String);

/** Mirrors the standard GLSL op for op; `fxFloatBits` is `floatBitsToUint`. */
const JS_SEED_KEY = `
var fxFloatBitsF=new Float32Array(1),fxFloatBitsU=new Uint32Array(fxFloatBitsF.buffer);
function fxFloatBits(x){fxFloatBitsF[0]=x;return fxFloatBitsU[0];}
function fxSeedHashKey(x,y,z,salt){return fxPcg((Math.imul(fxFloatBits(x),${P0})^Math.imul(fxFloatBits(y),${P1})^Math.imul(fxFloatBits(z),${P2})^fxPcg(fxFloatBits(salt)))>>>0);}`;

function jsSeedHash(components: FXSeedHashComponents): string {
  const name = seedHashGLSLName(components);
  if (components === 1) {
    return `function ${name}(x,y,z,salt){return fxUnit(fxSeedHashKey(x,y,z,salt));}`;
  }
  const units = Array.from(
    { length: components },
    (_, i) => `${i > 0 ? "h=fxPcg(h);" : ""}r[${i.toString()}]=fxUnit(h);`,
  ).join("");
  return jsMemoized(
    name,
    ["x", "y", "z", "salt"],
    components,
    `var h=fxSeedHashKey(x,y,z,salt);${units}`,
  );
}

/** `fxSeedHash1(x, y, z, salt)`; wider results take a trailing component index. */
export const FX_JS_SEED_HASH: FXHelperModule = {
  key: "seedHash",
  requires: [FX_JS_NOISE_HASH],
  source: [JS_SEED_KEY, ...FX_SEED_HASH_COMPONENTS.map(jsSeedHash)].join("\n"),
};
