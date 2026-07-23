import type { FXGraph } from "../core/FXGraph";
import type { FXBehaviorNode } from "./FXBehaviorNode";
import type { FXCompiledKernel } from "./FXCompiledKernel";
import type { FXBehaviorTargets } from "./FXParticleBehaviorTarget";
import { compileBehavior } from "./FXParticleBehaviorKernel.Internal";
import { compileBehaviorStandard } from "./FXParticleBehaviorKernelStandard.Internal";
import type { FXFusedProgramStandard } from "./FXKernelBuildStandard.Internal";
import { assembleTransformFeedbackProgram } from "./FXKernelBuildStandard.Internal";

/**
 * The mandatory JS kernel plus whichever optional simulation families this compile attempted and
 * succeeded at. One named, optional field per family - never a `Record<id, artifact>`: the
 * families' artifact shapes genuinely differ (JS closures vs. GLSL text vs., eventually, a WGSL
 * compute-dispatch program), so a homogeneous map across them is the wrong abstraction boundary -
 * the render side's own artifact-by-tier shape makes the same choice. A future compute family
 * adds one more sibling optional field here, nothing else in this type changes shape.
 */
export interface FXCompiledBehaviorBundle {
  readonly kernel: FXCompiledKernel;
  readonly standardProgram?: FXFusedProgramStandard;
}

/**
 * Attempts one optional family's compile; never throws - a family that cannot compile this graph
 * is silently absent from the bundle, the same tolerance every optional family gets from this one
 * place, not re-implemented per family. Purely a control-flow helper - it does not know what
 * "standard" or "compute" mean, only that a family id names a compile attempt for the warning text.
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

/**
 * Compiles the mandatory JS kernel, then makes one independent attempt per optional simulation
 * family the target opted into - flat, one line per family, not a loop over a shared registry
 * (families are not interchangeable) and not a branch inside any family's own compiler (families
 * do not know about each other). This is the one place in the codebase that does.
 */
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
