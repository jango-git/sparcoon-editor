import type { FXFunctionDef } from "../core/ir/FXFunctions.Internal";

export const FX_SEEDED_RANDOM = "seededRandom";

/**
 * JS-only helpers (LUT sampling, the CPU random draw) with no GLSL form, merged over FX_FUNCTIONS
 * for the JS printer.
 */
export const FX_BEHAVIOR_FUNCTIONS: ReadonlyMap<string, FXFunctionDef> = new Map<
  string,
  FXFunctionDef
>([
  [
    // The LUT argument is a Float32Array binding typed `float` in the IR - it is
    // only ever handed to this sampler, never used arithmetically.
    "sampleLut",
    {
      name: "sampleLut",
      signatures: [{ args: ["float", "float"], result: "float" }],
      js: (args) => `fxSampleLut(${args[0]}, ${args[1]})`,
      jsHelper: ["fxSampleLut"],
    },
  ],
  [
    FX_SEEDED_RANDOM,
    {
      name: FX_SEEDED_RANDOM,
      signatures: [{ args: ["float", "int", "int"], result: "float" }],
      js: (args) => `fxRandom(${args[0]}, ${args[1]}, ${args[2]})`,
      jsHelper: ["fxRandom"],
    },
  ],
]);
