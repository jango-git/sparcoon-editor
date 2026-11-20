import { FXGraphNode } from "../core/FXGraphNode";
import type { FXRenderContext } from "./compiler/FXRenderContext";
import type { FXShaderStage } from "./FXShaderStage";

export abstract class FXRenderNode extends FXGraphNode<FXRenderContext> {
  /** `true` when the node has no intrinsic stage (a pure param/shared node, e.g. `constant`):
   *  the compiler places it by its consumers instead of the declared {@link stage}. */
  public readonly stageFlexible: boolean = false;
  public abstract readonly stage: FXShaderStage;
}
