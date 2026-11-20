import type { FXGraph } from "../core/FXGraph";
import type { FXBehaviorNode } from "./FXBehaviorNode";
import type { FXCompiledKernel } from "./FXCompiledKernel";
import type { FXFusedProgramStandard } from "./FXKernelBuildStandard.Internal";
import { assembleTransformFeedbackProgram } from "./FXKernelBuildStandard.Internal";
import { compileBehavior } from "./FXParticleBehaviorKernel.Internal";
import { compileBehaviorStandard } from "./FXParticleBehaviorKernelStandard.Internal";
import type { FXBehaviorTargets } from "./FXParticleBehaviorTarget";

/**
 * The mandatory JS kernel plus each optional simulation family that compiled. One optional field
 * per family, since the artifact shapes differ.
 */
export interface FXCompiledBehaviorBundle {
  readonly kernel: FXCompiledKernel;
  readonly standardProgram?: FXFusedProgramStandard;
}

/**
 * Runs one optional family's compile. Never throws. A family that fails to compile is left out of
 * the bundle (`familyId` names it in the warning).
 */
function tryCompileFamily<TArtifact>(
  familyId: string,
  compile: () => TArtifact,
): TArtifact | undefined {
  try {
    return compile();
  } catch (error) {
    console.warn(
      `compileBehaviorBundle: "Try GPU simulation" was on, but the graph could not compile to ` +
        `the ${familyId} family - falling back to the JS kernel for this emitter.`,
      error,
    );
    return undefined;
  }
}

/** Compiles the JS kernel, then tries each opted-in family independently. */
export function compileBehaviorBundle(
  graph: FXGraph<FXBehaviorNode>,
  targets: FXBehaviorTargets,
): FXCompiledBehaviorBundle {
  const kernel = compileBehavior(graph, targets);
  const standardProgram =
    targets.tryGpuSimulation === true
      ? tryCompileFamily("standard", () =>
          assembleTransformFeedbackProgram(compileBehaviorStandard(graph, targets)),
        )
      : undefined;
  return standardProgram === undefined ? { kernel } : { kernel, standardProgram };
}
