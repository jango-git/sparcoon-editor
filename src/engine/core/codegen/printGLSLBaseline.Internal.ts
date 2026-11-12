import type { FXExpr } from "../ir/FXExpr";
import type { FXFunctionDef } from "../ir/FXFunctions.Internal";
import type { FXGLSLPrintResult, FXGLSLSpelling, FXRefResolver } from "./printGLSL.Internal";
import { printGLSL, REF_BY_NAME } from "./printGLSL.Internal";

/**
 * The baseline-tier (WebGL1/GLSL-ES-1.00) printer: spells a function by its `glslBaseline`/
 * `glslBaselineHelper` fields. The language itself prints through the shared `printGLSL`.
 */
export function printGLSLBaseline(
  expression: FXExpr,
  functions: ReadonlyMap<string, FXFunctionDef>,
  resolveRef: FXRefResolver = REF_BY_NAME,
): FXGLSLPrintResult {
  return printGLSL(expression, functions, resolveRef, spelling);
}

function spelling(definition: FXFunctionDef): FXGLSLSpelling {
  return { spelling: definition.glslBaseline, helper: definition.glslBaselineHelper };
}
