import type { FXCompilerContext } from "../core/compiler/FXCompilerContext";
import type { FXExpr } from "../core/ir/FXExpr";
import type { FXAssetKind } from "../core/nodes/FXAssetKind";
import type { FXBehaviorPhase } from "./FXBehaviorPhase";
import type { FXKernelBindingDescriptor, FXKernelBindingHandle } from "./FXCompiledKernel";

export interface FXKernelContext extends FXCompilerContext {
  readonly phase: FXBehaviorPhase;

  allocateBinding(descriptor: FXKernelBindingDescriptor): FXKernelBindingHandle;

  /**
   * A mesh asset as its surface table, a `sampler2D` for `meshFetch` (the phase's `meshSurfaces`), or a
   * volume asset as its R8 3D texture, a `sampler3D` for `volumeFetch` (the phase's `volumes`).
   */
  allocateAsset(kind: FXAssetKind, name: string): FXExpr;
}
