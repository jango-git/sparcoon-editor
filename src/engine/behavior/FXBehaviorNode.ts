import type { FXKernelContext } from "./FXKernelContext";
import type { FXBehaviorPhase } from "./FXBehaviorPhase";
import { FXGraphNode } from "../core/FXGraphNode";

/**
 * Base for CPU behavior-backend nodes: an {@link FXGraphNode} bound to {@link FXKernelContext},
 * additionally declaring its execution phase (SPAWN at birth, UPDATE per frame).
 */
export abstract class FXBehaviorNode extends FXGraphNode<FXKernelContext> {
  /** `true` for a phase-agnostic node (e.g. `constant`, `split`): compiled into every
   * phase that consumes it, rather than one fixed phase. */
  public readonly phaseFlexible: boolean = false;
  /** Phase this node runs in; for a {@link phaseFlexible} node this is only a fallback -
   * the compiler places it by its consumers. */
  public abstract readonly phase: FXBehaviorPhase;
}
