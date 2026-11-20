import type { FXGLSLRenderTier } from "sparcoon/editor";

import type { FXValidationResult } from "../../core/compiler/FXCompilerError";
import type { FXGraph } from "../../core/FXGraph";
import type { FXRenderNode } from "../FXRenderNode";
import type { FXTarget } from "../target/FXTarget";
import type { FXCompiledShader } from "./FXCompiledShader";
import { FXCompilerBaseline } from "./FXCompilerBaseline";
import { FXCompilerStandard } from "./FXCompilerStandard";

/**
 * Contract of a render compiler, generic over the artifact type. The GLSL compilers are independent
 * implementations, kept equal by running the same graphs through all of them in tests.
 */
export interface FXRenderCompiler<TArtifact = FXCompiledShader> {
  validate(graph: FXGraph<FXRenderNode>, target: FXTarget): FXValidationResult;
  previewHash(graph: FXGraph<FXRenderNode>, target: FXTarget): string;
  compile(graph: FXGraph<FXRenderNode>, target: FXTarget): TArtifact;
}

export type { FXGLSLRenderTier };

/** The registered GLSL render compilers by tier. The export iterates this map. */
export const FX_GLSL_RENDER_COMPILERS: Readonly<
  Record<FXGLSLRenderTier, FXRenderCompiler<FXCompiledShader>>
> = {
  baseline: new FXCompilerBaseline(),
  standard: new FXCompilerStandard(),
};
