/**
 * The behavior graph's structural hash - a whole-graph cache key over node types, resolved generic
 * `T`, and (since a node's `phase` can be instance-variable) its resolved placement phase. Used both
 * standalone (the live orchestrator's recompile-vs-rebind gate) and inside a real compile, so the
 * two stay byte-for-byte in sync.
 */

import { prepareCompile } from "../core/compiler/compileDriver.Internal";
import { structuralHash } from "../core/compiler/FXStructuralHash.Internal";
import { genericTypeTag } from "../core/compiler/FXTypeResolve.Internal";
import type { FXBehaviorNode } from "./FXBehaviorNode";
import type { FXBehaviorPhase } from "./FXBehaviorPhase";
import type { FXGraph } from "../core/FXGraph";
import type { FXValueType } from "../core/socket/FXValueType";
import type { FXBehaviorTargets } from "./FXParticleBehaviorTarget";
import { behaviorTargetsSignature } from "./FXKernelTargetSignature.Internal";
import { phaseTag, resolvePlacementPhases } from "./FXKernelValidation.Internal";

/**
 * A behavior node's `phase` is instance-variable (a `const` node may be SPAWN or
 * UPDATE) and routes it to a different phase kernel, so it is structural - folded
 * into the hash here rather than left to each node's `cacheKey`. A node's resolved
 * generic type `T` is folded in the same way (it decides the shape of the emitted
 * code); `types` is the whole-graph resolution keyed by node id.
 */
export function behaviorNodeKey(
  types: ReadonlyMap<string, FXValueType>,
  phases: ReadonlyMap<string, FXBehaviorPhase>,
): (id: string, node: FXBehaviorNode) => string {
  return (id, node) => `${phaseTag(phases, id, node)}${genericTypeTag(types, id)}`;
}

/**
 * Structural hash of a whole behavior graph, without emitting a kernel - matches
 * the hash `compileBehavior` produces, for the live orchestrator's
 * recompile-vs-rebind gate.
 */
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
