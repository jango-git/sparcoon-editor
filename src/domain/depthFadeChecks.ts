/**
 * The render-mode rule for a graph that reads the scene depth (a Depth Fade node) - shared by the
 * live preview and the export, so the two never accept different graphs. The runtime enforces the
 * same rule; this pins it to the node, before anything is built.
 */

import type { FXCompilerError } from "../engine/core/compiler/FXCompilerError";
import { collectReachableNodeIds } from "../engine/core/compiler/FXGraphTraversal.Internal";
import type { FXGraph } from "../engine/core/FXGraph";
import type { FXGraphNode } from "../engine/core/FXGraphNode";
import type { RenderMode } from "./sinkMeta";

/**
 * Every reachable node of `graph` reading the scene depth, when `renderMode` writes depth: drawn
 * into the scene's depth, such a material would fade against itself.
 */
export function depthFadeModeErrors(
  graph: FXGraph<FXGraphNode>,
  renderMode: RenderMode,
): readonly FXCompilerError[] {
  if (renderMode === "blending") {
    return [];
  }
  return [...collectReachableNodeIds(graph)]
    .filter((id) => graph.getNode(id)?.readsSceneDepth === true)
    .map((id) => ({
      code: "depth-fade-needs-blending",
      message:
        `Depth Fade works only in the blending render mode, not ${renderMode}: ` +
        "a depth-writing surface would fade against its own depth",
      nodeId: id,
      params: { mode: renderMode },
    }));
}
