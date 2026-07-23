import type { FXRenderContext } from "./compiler/FXRenderContext";
import { FXGraphNode } from "../core/FXGraphNode";
import type { FXShaderStage } from "./FXShaderStage";

/** Base for render-backend nodes: an {@link FXGraphNode} bound to an {@link FXRenderContext} that
 *  also declares which shader stage it emits into. */
export abstract class FXRenderNode extends FXGraphNode<FXRenderContext> {
  /** `true` when the node has no intrinsic stage (a pure param/shared node, e.g. `constant`):
   *  the compiler places it by its consumers instead of the declared {@link stage}. */
  public readonly stageFlexible: boolean = false;
  /** For a placement-flexible node (see {@link stageFlexible}) this is only a fallback; the
   *  compiler infers the effective stage from the graph. */
  public abstract readonly stage: FXShaderStage;
}
