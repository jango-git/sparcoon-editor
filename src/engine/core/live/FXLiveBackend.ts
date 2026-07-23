import type { FXValidationResult } from "../compiler/FXCompilerError";
import type { FXGraph } from "../FXGraph";
import type { FXGraphNode } from "../FXGraphNode";

/**
 * Backend strategy for {@link FXLiveGraph} - localizes the render-vs-behavior difference
 * behind one interface so the orchestrator's gate stays generic.
 */
export interface FXLiveBackend<N extends FXGraphNode, A> {
  /** Structured, non-throwing compilability check for the current graph. */
  validate(graph: FXGraph<N>): FXValidationResult;

  /**
   * Cheap structural hash (reachability + topo-order + `structuralHash`), no codegen.
   * Must match the hash {@link compile}'s artifact would carry, to gate recompile vs.
   * rebind before paying for a compile.
   */
  previewHash(graph: FXGraph<N>): string;

  /** Full compile of the current graph into an installable artifact. */
  compile(graph: FXGraph<N>): A;

  /** Hot-swaps the artifact into the live runtime (mesh material / kernels). */
  install(artifact: A): void;
}
