import type { FXExpr } from "../ir/FXExpr";
import type { FXFunctionDef } from "../ir/FXFunctions.Internal";
import type { FXGLSLPrintResult, FXGLSLSpelling, FXRefResolver } from "./printGLSL.Internal";
import { printGLSL, REF_BY_NAME } from "./printGLSL.Internal";

/**
 * The standard-tier (WebGL2/GLSL-ES-3.00) printer: spells a function by its `glslStandard`/
 * `glslStandardHelper` fields, falling back to `glslBaseline`/`glslBaselineHelper` when a function
 * prints identically either way. The language itself prints through the shared `printGLSL`.
 */
export function printGLSLStandard(
  expression: FXExpr,
  functions: ReadonlyMap<string, FXFunctionDef>,
  resolveRef: FXRefResolver = REF_BY_NAME,
): FXGLSLPrintResult {
  return printGLSL(expression, functions, resolveRef, spelling);
}

function spelling(definition: FXFunctionDef): FXGLSLSpelling {
  return {
    spelling: definition.glslStandard ?? definition.glslBaseline,
    helper: definition.glslStandardHelper ?? definition.glslBaselineHelper,
  };
}
