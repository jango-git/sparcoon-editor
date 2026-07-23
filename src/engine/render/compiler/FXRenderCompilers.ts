import type { FXGraph } from "../../core/FXGraph";
import type { FXRenderNode } from "../FXRenderNode";
import type { FXTarget } from "../target/FXTarget";
import type { FXValidationResult } from "../../core/compiler/FXCompilerError";
import type { FXCompiledShader } from "./FXCompiledShader";
import { FXCompilerBaseline } from "./FXCompilerBaseline";
import { FXCompilerStandard } from "./FXCompilerStandard";

/**
 * Shared contract every render compiler implements - a structural interface, not a common base
 * class: `FXCompilerBaseline`/`FXCompilerStandard` are independent implementations, and parity
 * between them is enforced by running the same graphs through every registered compiler in tests,
 * not by sharing an implementation.
 *
 * Generic over the compiled artifact type: `FXCompiledShader` (GLSL-text-shaped: vertex/fragment
 * body strings, uniform declarations) is what every GLSL-family compiler produces, but a
 * structurally different family (e.g. a WGSL/WebGPU compiler, whose artifact is a shader module +
 * bind-group-layout descriptor) could never legally return one. Making this generic is what lets
 * that future family declare its own `FXRenderCompiler<FXCompiledWGSLModule>` sibling registry
 * instead of being forced into this one's shape.
 */
export interface FXRenderCompiler<TArtifact = FXCompiledShader> {
  validate(graph: FXGraph<FXRenderNode>, target: FXTarget): FXValidationResult;
  previewHash(graph: FXGraph<FXRenderNode>, target: FXTarget): string;
  compile(graph: FXGraph<FXRenderNode>, target: FXTarget): TArtifact;
}

/**
 * A GLSL render tier id - matches the `sparcoon` runtime's `FXGLSLRenderTier`. Deliberately NOT
 * named "render compiler id" in general: this id space is scoped to the GLSL family (baseline =
 * WebGL1/GLSL-ES-1.00, standard = WebGL2/GLSL-ES-3.00). A future advanced tier (WebGPU/WGSL) is a
 * structurally different family and gets its own, differently-named id type, never a third member
 * of this union.
 */
export type FXGLSLRenderTier = "baseline" | "standard";

/**
 * Every registered GLSL-family render compiler, by tier. A caller (the export pipeline) iterates
 * this map instead of hardcoding two compiler names, so a new GLSL tier is an additive
 * registration here. A structurally different FAMILY (the future advanced/WebGPU/WGSL tier) is
 * explicitly NOT an additive entry in this same map - it would need its own
 * `FXRenderCompiler<TItsArtifact>` instantiation and its own sibling registry, combined with this
 * one only at the export layer that already knows how to shape a project's final artifact set.
 */
export const FX_GLSL_RENDER_COMPILERS: Readonly<
  Record<FXGLSLRenderTier, FXRenderCompiler<FXCompiledShader>>
> = {
  baseline: new FXCompilerBaseline(),
  standard: new FXCompilerStandard(),
};
