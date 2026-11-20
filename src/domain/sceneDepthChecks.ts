/**
 * Depth Fade needs a render mode that writes no depth, which the runtime enforces too. Depth Sample
 * reads depth only on the GPU.
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

/**
 * A warning on every reachable node of `behavior` reading the scene depth when its emitter is not
 * simulated on the GPU (`gpuSimulated`: a GPU kernel compiled for it) - the CPU simulation has no
 * depth, so a Depth Sample there finds no surface.
 */
export function cpuSceneDepthWarnings(
  behavior: FXGraph<FXGraphNode>,
  gpuSimulated: boolean,
): readonly FXCompilerError[] {
  if (gpuSimulated) {
    return [];
  }
  return [...collectReachableNodeIds(behavior)]
    .filter((id) => behavior.getNode(id)?.readsSceneDepth === true)
    .map((id) => ({
      code: "scene-depth-on-cpu",
      message:
        "Depth Sample reads the scene depth only in the GPU simulation - turn Try GPU Simulation " +
        "on, and keep the emitter from being the source of a reaction",
      nodeId: id,
    }));
}
