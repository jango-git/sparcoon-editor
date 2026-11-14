/**
 * The mesh-asset rule for a behavior graph that samples a mesh surface - shared by the live
 * preview and the export, so the two never accept different graphs. The runtime requires the
 * geometry too; this pins a missing one to its node before anything is built.
 */

import type { FXBehaviorNode } from "../engine/behavior/FXBehaviorNode";
import type { FXCompilerError } from "../engine/core/compiler/FXCompilerError";
import { collectReachableNodeIds } from "../engine/core/compiler/FXGraphTraversal.Internal";
import type { FXGraph } from "../engine/core/FXGraph";

/** Every reachable node of `graph` sampling a mesh asset not in `meshAssetNames`. */
export function missingMeshAssetErrors(
  graph: FXGraph<FXBehaviorNode>,
  meshAssetNames: readonly string[],
): readonly FXCompilerError[] {
  const known = new Set(meshAssetNames);
  const errors: FXCompilerError[] = [];
  for (const id of [...collectReachableNodeIds(graph)].sort()) {
    const name = graph.getNode(id)?.meshSurface;
    if (name !== undefined && !known.has(name)) {
      errors.push({
        code: "missing-mesh-asset",
        message: `No mesh asset "${name}" in the content library `,
        nodeId: id,
        params: { name },
      });
    }
  }
  return errors;
}
