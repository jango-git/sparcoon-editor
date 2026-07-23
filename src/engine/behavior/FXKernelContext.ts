import type { FXBehaviorPhase } from "./FXBehaviorPhase";
import type { FXKernelBindingDescriptor, FXKernelBindingHandle } from "./FXCompiledKernel";
import type { FXCompilerContext } from "../core/compiler/FXCompilerContext";

/**
 * {@link FXCompilerContext} for the CPU behavior backend: nodes emit JS over particle state
 * instead of GLSL, and capture live values via {@link allocateBinding} rather than uniforms.
 */
export interface FXKernelContext extends FXCompilerContext {
  /** Phase the current {@link FXBehaviorNode.build} call is emitting into. */
  readonly phase: FXBehaviorPhase;

  /** Captures an external value and returns a live handle for runtime updates. */
  allocateBinding(descriptor: FXKernelBindingDescriptor): FXKernelBindingHandle;
}
