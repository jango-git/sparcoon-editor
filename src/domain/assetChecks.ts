/**
 * The asset rule for a behavior graph that samples content-library assets - shared by the live
 * preview and the export, so the two never accept different graphs. The runtime requires each
 * asset too. This pins a missing one to its node before anything is built.
 */

import type { FXBehaviorNode } from "../engine/behavior/FXBehaviorNode";
import type { FXCompilerError, FXCompilerErrorCode } from "../engine/core/compiler/FXCompilerError";
import { collectReachableNodeIds } from "../engine/core/compiler/FXGraphTraversal.Internal";
import type { FXGraph } from "../engine/core/FXGraph";
import type { FXAssetKind } from "../engine/core/nodes/FXAssetKind";

/** The content library's asset names, by kind. */
export type LibraryAssetNames = Readonly<Record<FXAssetKind, readonly string[]>>;

/** A library holding nothing. */
export const NO_LIBRARY_ASSETS: LibraryAssetNames = { mesh: [], volume: [] };

const MISSING: Readonly<Record<FXAssetKind, { code: FXCompilerErrorCode; noun: string }>> = {
  mesh: { code: "missing-mesh-asset", noun: "mesh" },
  volume: { code: "missing-volume-asset", noun: "volume" },
};

/** Every reachable node of `graph` sampling an asset `library` does not hold. */
export function missingAssetErrors(
  graph: FXGraph<FXBehaviorNode>,
  library: LibraryAssetNames,
): readonly FXCompilerError[] {
  const errors: FXCompilerError[] = [];
  for (const id of [...collectReachableNodeIds(graph)].sort()) {
    for (const { kind, name } of graph.getNode(id)?.assetReads ?? []) {
      if (!library[kind].includes(name)) {
        const { code, noun } = MISSING[kind];
        errors.push({
          code,
          message: `No ${noun} asset "${name}" in the content library`,
          nodeId: id,
          params: { name },
        });
      }
    }
  }
  return errors;
}
