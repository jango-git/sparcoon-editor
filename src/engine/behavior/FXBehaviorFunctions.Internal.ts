import type { FXFunctionDef } from "../core/ir/FXFunctions.Internal";
import {
  SAMPLE_LUT_FN_NAME,
  SAMPLE_LUT_HELPER_SOURCE,
} from "./nodes/FXBehaviorNodeShared.Internal";

/**
 * JS-only helper functions (LUT sampling) with no GLSL form, merged over the core
 * {@link FX_FUNCTIONS} registry for the behavior/JS printer only (see {@link FX_BEHAVIOR_ALL_FUNCTIONS}).
 * `noise` itself lives in the core registry now (both a GLSL and a JS form), not here.
 * @internal
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
      js: (args) => `${SAMPLE_LUT_FN_NAME}(${args[0]}, ${args[1]})`,
      jsHelper: SAMPLE_LUT_HELPER_SOURCE,
    },
  ],
]);
