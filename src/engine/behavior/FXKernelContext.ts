import type { FXCompilerContext } from "../core/compiler/FXCompilerContext";
import type { FXExpr } from "../core/ir/FXExpr";
import type { FXBehaviorPhase } from "./FXBehaviorPhase";
import type { FXKernelBindingDescriptor, FXKernelBindingHandle } from "./FXCompiledKernel";

/**
 * {@link FXCompilerContext} for the CPU behavior backend: nodes emit JS over particle state
 * instead of GLSL, and capture live values via {@link allocateBinding} rather than uniforms.
 */
export interface FXKernelContext extends FXCompilerContext {
  /** Phase the current {@link FXBehaviorNode.build} call is emitting into. */
  readonly phase: FXBehaviorPhase;

  /** Captures an external value and returns a live handle for runtime updates. */
  allocateBinding(descriptor: FXKernelBindingDescriptor): FXKernelBindingHandle;

  /**
   * The surface table of mesh asset `mesh`, as a `sampler2D` value for `meshFetch`: no binding,
   * but a resource the runtime fills from the app's geometry of that name (the phase's `surfaces`).
   * Every call for one mesh in a phase reads the same table.
   */
  allocateSurface(mesh: string): FXExpr;
}
