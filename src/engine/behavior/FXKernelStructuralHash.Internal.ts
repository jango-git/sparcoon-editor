/**
 * Whole-graph cache key over node types, resolved generics and inferred phases. Shared by the
 * recompile-or-rebind gate and the compile, so they agree.
 */

import { prepareCompile } from "../core/compiler/compileDriver.Internal";
import { structuralHash } from "../core/compiler/FXStructuralHash.Internal";
import { genericTypeTag } from "../core/compiler/FXTypeResolve.Internal";
import type { FXGraph } from "../core/FXGraph";
import type { FXValueType } from "../core/socket/FXValueType";
import type { FXBehaviorNode } from "./FXBehaviorNode";
import type { FXBehaviorPhase } from "./FXBehaviorPhase";
import { behaviorTargetsSignature } from "./FXKernelTargetSignature.Internal";
import { phaseTag, resolvePlacementPhases } from "./FXKernelValidation.Internal";
import type { FXBehaviorTargets } from "./FXParticleBehaviorTarget";

/**
 * Phase and resolved type `T` are folded into the hash here: both change the emitted code and are
 * not in a node's `cacheKey`.
 */
export function behaviorNodeKey(
  types: ReadonlyMap<string, FXValueType>,
  phases: ReadonlyMap<string, FXBehaviorPhase>,
): (id: string, node: FXBehaviorNode) => string {
  return (id, node) => `${phaseTag(phases, id, node)}${genericTypeTag(types, id)}`;
}

export function previewBehaviorHash(
  graph: FXGraph<FXBehaviorNode>,
  targets: FXBehaviorTargets,
): string {
  const { order, resolution } = prepareCompile(graph);
  const phases = resolvePlacementPhases(graph, targets, order);
  return structuralHash(
    graph,
    behaviorTargetsSignature(targets),
    order,
    behaviorNodeKey(resolution.types, phases),
  );
}
