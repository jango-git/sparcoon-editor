/**
 * Depth sorting on an emitter whose particles live on the GPU: the runtime has no CPU-visible
 * positions to sort there, so `sortCamera` is ignored (with a console warning only). Shared by
 * the live preview and the export, so the two flag the same emitters.
 */

import type { FXCompilerError } from "../engine/core/compiler/FXCompilerError";
import { RENDER_SINK_ID } from "./sinkMeta";

/**
 * A warning when the render graph asks for a depth sort (`sortInterval` > 0) on an emitter that
 * runs its simulation on the GPU (`runsOnGpu`): the sort does nothing there. Attributed to the
 * render graph's surface sink, where Sort Every lives.
 */
export function gpuSortWarnings(sortInterval: number, runsOnGpu: boolean): FXCompilerError[] {
  return sortInterval > 0 && runsOnGpu
    ? [
        {
          code: "sort-on-gpu-emitter",
          message:
            "depth sorting has no effect on a GPU-simulated emitter - turn off the spawn sink's Try GPU Simulation, or set Sort Every to 0",
          nodeId: RENDER_SINK_ID,
        },
      ]
    : [];
}
