import { FXGraphNode } from "../core/FXGraphNode";
import type { FXBehaviorPhase } from "./FXBehaviorPhase";
import type { FXInheritRequest } from "./FXInheritPlan";
import type { FXKernelContext } from "./FXKernelContext";

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

  /**
   * The value this node inherits from the particle whose death spawned the newborn;
   * {@link collectInheritRequests} gathers these across the reachable graph into the emitter's
   * inherit layout. Absent for every node but `inherited-attribute`.
   */
  public get inheritRequest(): FXInheritRequest | undefined {
    return undefined;
  }
}
