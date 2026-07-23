import type { FXGraph } from "../FXGraph";
import type { FXGraphNode } from "../FXGraphNode";
import type { FXAttributeRequest } from "../socket/FXAttribute";
import type { FXCompilerError } from "./FXCompilerError";
import { collectReachableNodeIds } from "./FXGraphTraversal.Internal";

/** The merged attribute set of a graph plus any conflicts found while merging. */
export interface FXAttributeCollection {
  /** Distinct requested attributes, ordered by name (stable for target naming). */
  readonly requests: readonly FXAttributeRequest[];
  /** One entry per name requested with two different types. */
  readonly errors: readonly FXCompilerError[];
}

/**
 * Merges the {@link FXAttributeRequest}s declared by the **reachable** nodes of a graph into one
 * deduplicated set - an unreachable `store-attribute`/`read-attribute` must not force a buffer.
 */
export function collectAttributeRequests(graph: FXGraph<FXGraphNode>): FXAttributeCollection {
  const reachable = collectReachableNodeIds(graph);
  const byName = new Map<string, FXAttributeRequest>();
  const errors: FXCompilerError[] = [];

  for (const id of reachable) {
    const request = graph.getNode(id)?.attributeRequest;
    if (request === undefined) {
      continue;
    }
    const existing = byName.get(request.name);
    if (existing === undefined) {
      byName.set(request.name, request);
      continue;
    }
    if (existing.type.id !== request.type.id) {
      errors.push({
        code: "attribute-type-conflict",
        message: `attribute "${request.name}" is requested as both ${existing.type.id} and ${request.type.id}`,
        nodeId: id,
      });
    }
  }

  const requests = [...byName.values()].sort((first, second) =>
    first.name < second.name ? -1 : first.name > second.name ? 1 : 0,
  );
  return { requests, errors };
}

/**
 * Flags a request naming (or mistyping) an attribute outside `declared` - catches an orphaned
 * `read-attribute` node left over after its attribute was removed or retyped elsewhere, which
 * neither {@link collectAttributeRequests} nor {@link mergeAttributeCollections} alone would see.
 */
export function collectUndeclaredAttributeErrors(
  requests: readonly FXAttributeRequest[],
  declared: ReadonlyMap<string, string>,
): readonly FXCompilerError[] {
  const errors: FXCompilerError[] = [];
  for (const request of requests) {
    const declaredType = declared.get(request.name);
    if (declaredType === undefined) {
      errors.push({
        code: "undeclared-attribute",
        message: `attribute "${request.name}" is not declared - it may have been removed`,
        params: { name: request.name },
      });
    } else if (declaredType !== request.type.id) {
      errors.push({
        code: "undeclared-attribute",
        message:
          `attribute "${request.name}" is declared as ${declaredType} but requested as ` +
          `${request.type.id} - it may have been retyped`,
        params: { name: request.name, declaredType, requestedType: request.type.id },
      });
    }
  }
  return errors;
}

/**
 * Merges the attribute sets of two graphs (behavior writer + render reader), surfacing a
 * cross-graph `attribute-type-conflict` when the two sides disagree on a name's type.
 */
export function mergeAttributeCollections(
  first: FXAttributeCollection,
  second: FXAttributeCollection,
): FXAttributeCollection {
  const byName = new Map<string, FXAttributeRequest>();
  const errors: FXCompilerError[] = [...first.errors, ...second.errors];

  for (const request of [...first.requests, ...second.requests]) {
    const existing = byName.get(request.name);
    if (existing === undefined) {
      byName.set(request.name, request);
    } else if (existing.type.id !== request.type.id) {
      errors.push({
        code: "attribute-type-conflict",
        message: `attribute "${request.name}" is requested as both ${existing.type.id} and ${request.type.id}`,
      });
    }
  }

  const requests = [...byName.values()].sort((first, second) =>
    first.name < second.name ? -1 : first.name > second.name ? 1 : 0,
  );
  return { requests, errors };
}
