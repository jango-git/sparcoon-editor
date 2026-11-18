import type { FXCallSignature } from "../FXExprBuilder";
import type { FXFunctionDef } from "../FXFunctions.Internal";
import type { FXJSHelperName } from "../FXHelpers.Internal";
import { fixedCurlGLSLName, fixedCurlHelper, fixedCurlName } from "./FXCurlNoise.Internal";
import {
  fixedFbmGLSLName,
  fixedFbmHelper,
  fixedFbmName,
  FX_FIXED_OCTAVE_COUNTS,
  type FXFixedOctaves,
} from "./FXFractalNoise.Internal";
import {
  FX_SEED_HASH_COMPONENTS,
  FX_SEED_HASH_TYPES,
  type FXSeedHashComponents,
  seedHashFunctionName,
  seedHashGLSLName,
} from "./FXSeedHash.Internal";
import {
  FX_VORONOI_METRICS,
  FX_VORONOI_QUALITIES,
  type FXVoronoiVariant,
  voronoiFunctionName,
  voronoiGLSLName,
  voronoiHelper,
  voronoiJSCodes,
} from "./FXVoronoiNoise.Internal";

/** Registry entries of the noise family: signatures, spellings and the helpers they call. */

const JS_NOISE: readonly FXJSHelperName[] = ["fxNoise1", "fxNoise2", "fxNoise3"];
const JS_FRACTAL: readonly FXJSHelperName[] = ["fxFractal1", "fxFractal2", "fxFractal3"];

const FRACTAL_PARAMS = ["float", "float", "float"] as const; // octaves, lacunarity, gain
const FIXED_FRACTAL_PARAMS = ["float", "float"] as const; // lacunarity, gain
type Position = "float" | "vec2" | "vec3";

/** `name<dimensions>(args)`, dimensions recovered from the flattened arity. */
function jsByArity(name: string, extraArgs: number): (args: readonly string[]) => string {
  return (args) => `${name}${(args.length - extraArgs).toString()}(${args.join(", ")})`;
}

/**
 * JS of a fixed-octave variant: the runtime-octave function with the count inserted after the
 * position (`trailing` = flattened args after it: lacunarity, gain[, component]).
 */
function jsFixedOctaves(
  name: string,
  octaves: FXFixedOctaves,
  trailing: number,
): (args: readonly string[]) => string {
  return (args) => {
    const position = args.slice(0, -trailing);
    return `${name}${position.length.toString()}(${[...position, octaves.toString(), ...args.slice(-trailing)].join(", ")})`;
  };
}

function signaturesOver(
  positions: readonly Position[],
  params: readonly "float"[],
  result: (position: Position) => Position,
): FXCallSignature[] {
  return positions.map((position) => ({ args: [position, ...params], result: result(position) }));
}

function fixedFbmDefinition(octaves: FXFixedOctaves): FXFunctionDef {
  return {
    name: fixedFbmName(octaves),
    signatures: signaturesOver(["float", "vec2", "vec3"], FIXED_FRACTAL_PARAMS, () => "float"),
    packed: true,
    glslBaseline: fixedFbmGLSLName(octaves),
    glslBaselineHelper: fixedFbmHelper(octaves),
    jsHelper: JS_FRACTAL,
    js: jsFixedOctaves("fxFractal", octaves, FIXED_FRACTAL_PARAMS.length),
  };
}

function fixedCurlDefinition(octaves: FXFixedOctaves): FXFunctionDef {
  return {
    name: fixedCurlName(octaves),
    signatures: signaturesOver(["vec2", "vec3"], FIXED_FRACTAL_PARAMS, (position) => position),
    packed: true,
    glslBaseline: fixedCurlGLSLName(octaves),
    glslBaselineHelper: fixedCurlHelper(octaves),
    jsHelper: ["fxCurl2", "fxCurl3"],
    // + the component index.
    js: jsFixedOctaves("fxCurl", octaves, FIXED_FRACTAL_PARAMS.length + 1),
  };
}

function voronoiDefinition(variant: FXVoronoiVariant): FXFunctionDef {
  const [quality, metric] = voronoiJSCodes(variant);
  return {
    name: voronoiFunctionName(variant),
    signatures: [
      { args: ["vec2", "float"], result: "vec3" },
      { args: ["vec3", "float"], result: "vec3" },
    ],
    packed: true,
    glslBaseline: voronoiGLSLName(variant),
    glslBaselineHelper: voronoiHelper(variant, "BASELINE"),
    glslStandardHelper: voronoiHelper(variant, "STANDARD"),
    jsHelper: ["fxVoronoi2", "fxVoronoi3"],
    // Flattened args: position components, jitter, component index.
    js: (args): string => {
      const position = args.slice(0, -2);
      const [jitter, component] = args.slice(-2);
      return `fxVoronoi${position.length.toString()}(${[...position, jitter, quality.toString(), metric.toString(), component].join(", ")})`;
    },
  };
}

function seedHashDefinition(components: FXSeedHashComponents): FXFunctionDef {
  return {
    name: seedHashFunctionName(components),
    signatures: [{ args: ["vec3", "float"], result: FX_SEED_HASH_TYPES[components] }],
    packed: true,
    glslBaseline: seedHashGLSLName(components),
    glslBaselineHelper: "FX_GLSL_BASELINE_SEED_HASH",
    glslStandardHelper: "FX_GLSL_STANDARD_SEED_HASH",
    jsHelper: [seedHashGLSLName(components)],
    js: (args) => `${seedHashGLSLName(components)}(${args.join(", ")})`,
  };
}

export function noiseFunctionDefinitions(): FXFunctionDef[] {
  const definitions: FXFunctionDef[] = [
    {
      name: "noise",
      signatures: [
        { args: ["float"], result: "float" },
        { args: ["vec2"], result: "float" },
        { args: ["vec3"], result: "float" },
      ],
      packed: true,
      glslBaselineHelper: "FX_GLSL_BASELINE_NOISE",
      glslStandardHelper: "FX_GLSL_STANDARD_NOISE",
      jsHelper: JS_NOISE,
      js: jsByArity("fxNoise", 0),
    },
    {
      name: "fbm",
      signatures: signaturesOver(["float", "vec2", "vec3"], FRACTAL_PARAMS, () => "float"),
      packed: true,
      glslBaseline: "fxFbm",
      glslBaselineHelper: "FX_GLSL_FBM",
      jsHelper: JS_FRACTAL,
      js: jsByArity("fxFractal", FRACTAL_PARAMS.length),
    },
  ];
  for (const octaves of FX_FIXED_OCTAVE_COUNTS) {
    definitions.push(fixedFbmDefinition(octaves), fixedCurlDefinition(octaves));
  }
  for (const quality of FX_VORONOI_QUALITIES) {
    for (const metric of FX_VORONOI_METRICS) {
      definitions.push(voronoiDefinition({ quality, metric }));
    }
  }
  for (const components of FX_SEED_HASH_COMPONENTS) {
    definitions.push(seedHashDefinition(components));
  }
  return definitions;
}
