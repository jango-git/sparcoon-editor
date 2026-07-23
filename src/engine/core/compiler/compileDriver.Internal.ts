import type { FXValidationResult } from "./FXCompilerError";
import { FXCompilerErrorException } from "./FXCompilerError";
import { tagNodeBuildError } from "./FXNodeBuildError.Internal";
import { collectReachableNodeIds, topologicalOrder } from "./FXGraphTraversal.Internal";
import type { FXTypeResolution } from "./FXTypeResolve.Internal";
import { resolveGenerics } from "./FXTypeResolve.Internal";
import type { FXGraph } from "../FXGraph";
import type { FXGraphNode } from "../FXGraphNode";

/**
 * Backend-neutral compile-driver spine shared by the render and behavior backends; placement,
 * output binding, artifact assembly, and hash timing stay backend-specific.
 */

/** The reachability / dependency-order / generic-resolution triple every compile pass opens with. */
export interface FXCompilePreparation {
  readonly reachable: ReadonlySet<string>;
  readonly order: readonly string[];
  readonly resolution: FXTypeResolution;
}

/**
 * Shared prologue of every compile / preview-hash pass; the backend then layers its own
 * placement (stages / phases) on `order` and builds / hashes.
 */
export function prepareCompile<N extends FXGraphNode>(graph: FXGraph<N>): FXCompilePreparation {
  const reachable = collectReachableNodeIds(graph);
  const { order } = topologicalOrder(graph, reachable);
  const resolution = resolveGenerics(graph, order);
  return { reachable, order, resolution };
}

/**
 * Runs each reachable node's `build` in dependency order, tagging any build-time throw with the
 * node id so an invalid op/type combo surfacing only at code-gen (M4) is node-attributed, not lost.
 */
export function buildNodes<N extends FXGraphNode>(
  graph: FXGraph<N>,
  order: readonly string[],
  buildNode: (node: N, id: string) => void,
): void {
  for (const id of order) {
    const node = graph.getNode(id);
    if (node === undefined) {
      continue;
    }
    try {
      buildNode(node, id);
    } catch (error) {
      throw tagNodeBuildError(error, id);
    }
  }
}

/**
 * Throws the first error of a failed validation as an {@link FXCompilerErrorException}, so a
 * static compile surface keeps the classification instead of a bare Error.
 */
export function throwIfInvalid(validation: FXValidationResult): void {
  if (validation.ok) {
    return;
  }
  const [first] = validation.errors;
  if (first === undefined) {
    throw new Error("Invalid validation result carries ok=false but no errors");
  }
  throw new FXCompilerErrorException({
    ...first,
    message: `${first.message} (${validation.errors.length.toString()} error(s) total)`,
  });
}
