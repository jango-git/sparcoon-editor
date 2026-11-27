/**
 * Pins a missing content-library asset to the behavior node that samples it, before anything is
 * built. The runtime requires each asset too.
 */

import type { FXBehaviorNode } from "../engine/behavior/FXBehaviorNode";
import type { FXCompilerError } from "../engine/core/compiler/FXCompilerError";
import { collectReachableNodeIds } from "../engine/core/compiler/FXGraphTraversal.Internal";
import type { FXGraph } from "../engine/core/FXGraph";
import { FX_ASSET_KINDS, type FXAssetKind, mapAssetKinds } from "../engine/core/nodes/FXAssetKind";

/** The content library's asset names, by kind. */
export type LibraryAssetNames = Readonly<Record<FXAssetKind, readonly string[]>>;

/** A library holding nothing. */
export const NO_LIBRARY_ASSETS: LibraryAssetNames = mapAssetKinds(() => []);

/** Every reachable node of `graph` sampling an asset `library` does not hold. */
export function missingAssetErrors(
  graph: FXGraph<FXBehaviorNode>,
  library: LibraryAssetNames,
): readonly FXCompilerError[] {
  const errors: FXCompilerError[] = [];
  for (const id of [...collectReachableNodeIds(graph)].sort()) {
    for (const { kind, name } of graph.getNode(id)?.assetReads ?? []) {
      if (!library[kind].includes(name)) {
        const { code, noun } = FX_ASSET_KINDS[kind].missing;
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
