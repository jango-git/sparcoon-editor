import type { FXCompilerContext } from "../../core/compiler/FXCompilerContext";
import type { FXValueType } from "../../core/socket/FXValueType";
import type { FXShaderStage } from "../FXShaderStage";
import type { FXUniformDescriptor, FXUniformHandle } from "./FXCompiledShader";

export interface FXRenderContext extends FXCompilerContext {
  readonly stage: FXShaderStage;

  allocateUniform(descriptor: FXUniformDescriptor): FXUniformHandle;

  allocateVarying(type: FXValueType): string;
}
