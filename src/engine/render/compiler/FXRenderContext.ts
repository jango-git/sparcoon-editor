import type { FXShaderStage } from "../FXShaderStage";
import type { FXValueType } from "../../core/socket/FXValueType";
import type { FXUniformDescriptor, FXUniformHandle } from "./FXCompiledShader";
import type { FXCompilerContext } from "../../core/compiler/FXCompilerContext";

/** {@link FXCompilerContext} for the render backend: adds the shader stage plus uniform and
 *  varying allocation. Cross-stage reads are routed through varyings automatically. */
export interface FXRenderContext extends FXCompilerContext {
  /** Stage the current {@link FXRenderNode.build} call is emitting into. */
  readonly stage: FXShaderStage;

  /** Declares a uniform and returns a live handle for runtime updates. */
  allocateUniform(descriptor: FXUniformDescriptor): FXUniformHandle;

  /** Allocates a vertex->fragment varying and returns its generated name. */
  allocateVarying(type: FXValueType, hint: string): string;
}
