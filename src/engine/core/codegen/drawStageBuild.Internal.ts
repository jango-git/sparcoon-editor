import type { FXCompiledDrawStage } from "./drawStage.Internal";

/** The parameters of an artifact's `compute`, in order - the printed and the built one alike, a
 *  render's and a GPU kernel's alike. */
export const DRAW_COMPUTE_PARAMETERS = ["inputs", "uniforms"] as const;

/** `compute`'s source: its helpers, then its statements. */
export function drawComputeSource(stage: FXCompiledDrawStage): string {
  return [...stage.helpers, ...stage.statements].join("\n");
}

/**
 * The editor's live `compute` for a compiled draw stage, typed as the artifact declares it (`F`) -
 * the `new Function` layer, like the behavior kernels' (`FXKernelBuild.Internal.ts`). Never in an
 * exported module: the export prints the same source as a method (`artifactLiterals.ts`), so no
 * shipped code is built from a string.
 */
export function buildDrawCompute<F>(stage: FXCompiledDrawStage): F {
  let built = BUILT.get(stage);
  if (built === undefined) {
    built = new Function(...DRAW_COMPUTE_PARAMETERS, drawComputeSource(stage));
    BUILT.set(stage, built);
  }
  return built as F;
}

// Each compiled stage's built `compute`: a value-only rebind reassembles from the same compiled
// stage, and builds nothing again.
const BUILT = new WeakMap<FXCompiledDrawStage, unknown>();
