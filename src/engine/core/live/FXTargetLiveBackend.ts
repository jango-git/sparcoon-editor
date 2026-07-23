import type { FXValidationResult } from "../compiler/FXCompilerError";
import { collectAttributeRequests } from "../compiler/collectAttributeRequests";
import type { FXAttributeRequest } from "../socket/FXAttribute";
import type { FXGraph } from "../FXGraph";
import type { FXGraphNode } from "../FXGraphNode";
import type { FXLiveBackend } from "./FXLiveBackend";

/**
 * The backend-specific pieces of a target-driven {@link FXLiveBackend}: deriving the
 * compile target from a graph's attribute requests, and the validate/hash/compile/install
 * trio over `(graph, target)`. Everything else - collecting requests, building the target,
 * folding attribute errors into `validate` only - is shared, in {@link FXTargetLiveBackend}.
 */
export interface FXTargetLiveBackendConfig<N extends FXGraphNode, A, T> {
  /** Derives the compile target for a snapshot from its collected attribute requests. */
  buildTarget(attributes: readonly FXAttributeRequest[]): T;
  /** Structured, non-throwing compilability check of the graph against its target. */
  validate(graph: FXGraph<N>, target: T): FXValidationResult;
  /** Cheap structural hash of the graph (no codegen), matching {@link compile}'s hash. */
  previewHash(graph: FXGraph<N>, target: T): string;
  /** Full compile of the graph into an installable artifact. */
  compile(graph: FXGraph<N>, target: T): A;
  /** Hot-swaps the artifact into the live runtime. */
  install(artifact: A): void;
}

/**
 * The target-driven half of a live backend, shared by render and behavior: each snapshot's
 * compile target derives from the graph's own attribute requests, so adding/removing one
 * reshapes the target (and, via the name salt, the structural hash) automatically.
 * Attribute-collection errors fold into {@link validate} only - `previewHash`/`compile`
 * consume the requests but not the errors, assuming an already-validated graph.
 */
export class FXTargetLiveBackend<N extends FXGraphNode, A, T> implements FXLiveBackend<N, A> {
  constructor(private readonly config: FXTargetLiveBackendConfig<N, A, T>) {}

  public validate(graph: FXGraph<N>): FXValidationResult {
    const attributes = collectAttributeRequests(graph);
    const result = this.config.validate(graph, this.config.buildTarget(attributes.requests));
    const errors = [...attributes.errors, ...result.errors];
    return { ok: errors.length === 0, errors };
  }

  public previewHash(graph: FXGraph<N>): string {
    return this.config.previewHash(graph, this.targetFor(graph));
  }

  public compile(graph: FXGraph<N>): A {
    return this.config.compile(graph, this.targetFor(graph));
  }

  public install(artifact: A): void {
    this.config.install(artifact);
  }

  private targetFor(graph: FXGraph<N>): T {
    return this.config.buildTarget(collectAttributeRequests(graph).requests);
  }
}
