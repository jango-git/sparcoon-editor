import type { FXCompilerError, FXValidationResult } from "../core/compiler/FXCompilerError";
import {
  collectReachableNodeIds,
  topologicalOrder,
} from "../core/compiler/FXGraphTraversal.Internal";
import { resolvePlacement } from "../core/compiler/placement.Internal";
import { validateGraph } from "../core/compiler/FXValidation.Internal";
import { FXGraph } from "../core/FXGraph";
import type { FXBehaviorNode } from "./FXBehaviorNode";
import { FXBehaviorPhase } from "./FXBehaviorPhase";
import type {
  FXBehaviorTargets,
  FXKernelTarget,
  FXKernelTargetOutput,
} from "./FXParticleBehaviorTarget";
import { kernelTargetShapeErrors, validateKernelTarget } from "./FXKernelTargetValidation.Internal";
import { BUILTIN_BUFFER } from "./FXKernelShared.Internal";

/**
 * Phase placement inference and the behavior-graph validators, plus the whole-graph
 * `validateBehavior`. The render analog is duplicated per tier in `FXCompilePipelineBaseline.Internal`
 * (baseline) and `FXCompilePipelineStandard.Internal` (standard); this module stays shared across
 * behavior's JS and standard-tier (GLSL/transform-feedback) backends instead, because what it
 * decides - a node's phase, a graph's structural well-formedness - does not depend on which
 * language a phase eventually prints to. Split out of `FXParticleBehaviorKernel.Internal`, which
 * imports these back.
 */

/**
 * Infers the effective phase of every reachable node. A fixed-phase node keeps its declared
 * phase; a flexible node is placed by its consumers - a spawn-only output slot (e.g.
 * `lifetime`) or an explicit `binding.phase` pins it, falling back to its own declared phase
 * with no signal, and to `update` on a spawn-less target or a phase conflict (surfaced
 * separately as a cross-phase error). One phase per node, so a live edit rebinds one handle.
 * Reverse topological order so consumers resolve before producers.
 */
export function resolvePlacementPhases(
  graph: FXGraph<FXBehaviorNode>,
  targets: FXBehaviorTargets,
  order: readonly string[],
): Map<string, FXBehaviorPhase> {
  const spawnExists = targets.spawn !== undefined;
  const updateSlots = new Set(targets.update.outputs.map((output) => output.slot));
  return resolvePlacement<FXBehaviorNode, FXBehaviorPhase>(graph, order, {
    isFlexible: (node) => node.phaseFlexible,
    fixedSlot: (node) => node.phase,
    resolveFlexible: (node, consumerSlots, bindings) => {
      let needsSpawn = consumerSlots.some((phase) => phase === FXBehaviorPhase.SPAWN);
      let needsUpdate = consumerSlots.some((phase) => phase === FXBehaviorPhase.UPDATE);
      for (const binding of bindings) {
        // An explicit sink phase is authoritative; otherwise a slot the update target
        // does not expose is spawn-only, so a binding to it pins the producer to spawn.
        if (binding.phase === "spawn") {
          needsSpawn = true;
        } else if (binding.phase === "update") {
          needsUpdate = true;
        } else if (!updateSlots.has(binding.slot)) {
          needsSpawn = true;
        }
      }
      return spawnExists && needsSpawn && !needsUpdate
        ? FXBehaviorPhase.SPAWN
        : needsUpdate
          ? FXBehaviorPhase.UPDATE
          : // No consumer/binding signal: fall back to the node's declared default phase
            // (guarded to update on a spawn-less target, which cannot host a spawn node).
            spawnExists
            ? node.phase
            : FXBehaviorPhase.UPDATE;
    },
  });
}

/**
 * Structural-hash tag for a node's inferred phase. Folded into the behavior hash so a
 * rewiring that moves a flexible node between phases recompiles rather than rebinds.
 */
export function phaseTag(
  phases: ReadonlyMap<string, FXBehaviorPhase>,
  id: string,
  node: FXBehaviorNode,
): string {
  return node.phaseFlexible ? (phases.get(id) ?? node.phase) : node.phase;
}

/**
 * Builds a single-phase view of a behavior graph (nodes/connections/bindings restricted to
 * `phase`), a legit {@link FXGraph} the shared validation/traversal machinery consumes unchanged.
 */
export function buildPhaseView(
  graph: FXGraph<FXBehaviorNode>,
  phase: FXBehaviorPhase,
  phaseOf: (id: string) => FXBehaviorPhase,
): FXGraph<FXBehaviorNode> {
  const nodes = new Map<string, FXBehaviorNode>();
  for (const [id, node] of graph.nodes) {
    if (phaseOf(id) === phase) {
      nodes.set(id, node);
    }
  }
  const connections = graph.connections.filter(
    (connection) => nodes.has(connection.from.nodeId) && nodes.has(connection.to.nodeId),
  );
  // `binding.phase` is the plain-string ABI representation, not the FXBehaviorPhase enum -
  // compare against its string form rather than the enum value directly.
  const phaseName = phase === FXBehaviorPhase.SPAWN ? "spawn" : "update";
  // A phase-tagged binding belongs to its own phase; an untagged one (render / legacy)
  // falls back to its producer's placement, which inference already put in this view.
  const outputBindings = graph.outputBindings.filter(
    (binding) =>
      nodes.has(binding.from.nodeId) &&
      (binding.phase === undefined || binding.phase === phaseName),
  );

  const view = new FXGraph<FXBehaviorNode>();
  view.ingest({ nodes, connections, outputBindings });
  return view;
}

/**
 * Flags reachable connections that cross phases - phases run as separate invocations at
 * different times, so only persisted state bridges them, never a direct value. Reachable-only
 * so an unreachable stray edge never blocks a preview.
 */
function detectCrossPhaseErrors(
  graph: FXGraph<FXBehaviorNode>,
  reachable: ReadonlySet<string>,
  phaseOf: (id: string) => FXBehaviorPhase,
): FXCompilerError[] {
  const errors: FXCompilerError[] = [];
  for (const connection of graph.connections) {
    if (!reachable.has(connection.to.nodeId)) {
      continue;
    }
    const from = graph.getNode(connection.from.nodeId);
    const to = graph.getNode(connection.to.nodeId);
    if (from === undefined || to === undefined) {
      continue;
    }
    // Compare effective (inferred) phases - a flexible node was placed in a single phase,
    // so a mismatch here is a genuine cross-phase dependency.
    const fromPhase = phaseOf(connection.from.nodeId);
    const toPhase = phaseOf(connection.to.nodeId);
    if (fromPhase === toPhase) {
      continue;
    }
    errors.push({
      code: "cross-phase-dependency",
      message: `input "${connection.to.socketKey}" of ${toPhase} node "${connection.to.nodeId}" is fed by ${fromPhase} node "${connection.from.nodeId}"; phases run at different times and share only persisted state`,
      nodeId: connection.to.nodeId,
      socketKey: connection.to.socketKey,
    });
  }
  return errors;
}

/**
 * Flags two distinct output slots in the same phase writing the same state offset (e.g.
 * `velocity` vec3 and `velocityZ` scalar) - the later write would silently win. Identical-slot
 * duplicates are caught separately by {@link validateGraph} (`duplicate-output-binding`).
 */
function detectOverlappingWrites(
  view: FXGraph<FXBehaviorNode>,
  target: FXKernelTarget,
): FXCompilerError[] {
  const errors: FXCompilerError[] = [];
  const outputBySlot = new Map<string, FXKernelTargetOutput>(
    target.outputs.map((output): [string, FXKernelTargetOutput] => [output.slot, output]),
  );
  // Keyed by buffer + offset: the same offset in different buffers is not an overlap.
  const offsetOwner = new Map<string, string>();
  for (const binding of view.outputBindings) {
    const output = outputBySlot.get(binding.slot);
    if (output === undefined) {
      continue;
    }
    const buffer = output.buffer ?? BUILTIN_BUFFER;
    for (const offset of output.offsets) {
      const key = `${buffer}:${offset.toString()}`;
      const owner = offsetOwner.get(key);
      if (owner !== undefined && owner !== binding.slot) {
        errors.push({
          code: "overlapping-output-slots",
          message: `output slots "${owner}" and "${binding.slot}" both write the same state offset in target "${target.name}"`,
          slot: binding.slot,
        });
      } else {
        offsetOwner.set(key, binding.slot);
      }
    }
  }
  return errors;
}

/**
 * Flags every reachable SPAWN-phase node when the targets carry no spawn phase - otherwise it
 * is silently dropped, shipping a graph whose spawn logic does nothing behind a green status.
 */
function detectUnsupportedSpawnPhase(
  graph: FXGraph<FXBehaviorNode>,
  reachable: ReadonlySet<string>,
): FXCompilerError[] {
  const errors: FXCompilerError[] = [];
  for (const id of reachable) {
    const node = graph.getNode(id);
    if (node?.phase === FXBehaviorPhase.SPAWN) {
      errors.push({
        code: "phase-not-supported",
        message: `node "${id}" runs in the spawn phase, but this target has no spawn phase (update-only)`,
        nodeId: id,
      });
    }
  }
  return errors;
}

/**
 * Cross-phase consistency of a spawn/update target pair: the host allocates buffers from the
 * update target only, so every spawn buffer must exist there with the same stride, or the two
 * kernels read the same storage at different strides (cross-particle corruption).
 */
function detectPhasePairErrors(spawn: FXKernelTarget, update: FXKernelTarget): FXCompilerError[] {
  const errors: FXCompilerError[] = [];
  const updateStrides = new Map(update.buffers.map((buffer) => [buffer.name, buffer.stride]));
  for (const buffer of spawn.buffers) {
    const updateStride = updateStrides.get(buffer.name);
    if (updateStride === undefined) {
      errors.push({
        code: "phase-buffer-not-in-update",
        message: `spawn target "${spawn.name}" declares buffer "${buffer.name}", which the update target "${update.name}" does not declare (the host allocates buffers from the update target only)`,
        params: { spawnName: spawn.name, bufferName: buffer.name, updateName: update.name },
      });
    } else if (updateStride !== buffer.stride) {
      errors.push({
        code: "phase-buffer-stride-mismatch",
        message: `buffer "${buffer.name}" has stride ${buffer.stride.toString()} in spawn target "${spawn.name}" but stride ${updateStride.toString()} in update target "${update.name}"`,
        params: {
          bufferName: buffer.name,
          spawnStride: buffer.stride,
          spawnName: spawn.name,
          updateStride,
          updateName: update.name,
        },
      });
    }
  }
  return errors;
}

/** Validates a behavior graph against both phase targets. Collects every error, never throws. */
export function validateBehavior(
  graph: FXGraph<FXBehaviorNode>,
  targets: FXBehaviorTargets,
): FXValidationResult {
  // A structurally malformed target literal fails fast here - the validators below
  // dereference the targets and would TypeError on it. `typeof null === "object"` too;
  // the tag check below excludes exactly that case without writing the banned null literal
  // (a plain truthy check collapses back to `!targets` under nearby autofixes, which
  // strict-boolean-expressions then rejects since `targets` is cast from `unknown`).
  if (
    typeof (targets as unknown) !== "object" ||
    Object.prototype.toString.call(targets) === "[object Null]"
  ) {
    return {
      ok: false,
      errors: [
        { code: "bad-behavior-targets-shape", message: "behavior targets must be an object" },
      ],
    };
  }
  const shapeErrors = [
    ...kernelTargetShapeErrors(targets.update),
    ...(targets.spawn === undefined ? [] : kernelTargetShapeErrors(targets.spawn)),
  ];
  if (shapeErrors.length > 0) {
    return { ok: false, errors: shapeErrors };
  }

  const reachable = collectReachableNodeIds(graph);
  const { order } = topologicalOrder(graph, reachable);
  const phases = resolvePlacementPhases(graph, targets, order);
  const phaseOf = (id: string): FXBehaviorPhase =>
    phases.get(id) ?? graph.getNode(id)?.phase ?? FXBehaviorPhase.UPDATE;
  const updateView = buildPhaseView(graph, FXBehaviorPhase.UPDATE, phaseOf);
  const errors: FXCompilerError[] = [
    ...validateKernelTarget(targets.update, "update"),
    ...detectCrossPhaseErrors(graph, reachable, phaseOf),
    ...validateGraph(updateView, targets.update).errors,
    ...detectOverlappingWrites(updateView, targets.update),
  ];
  // The spawn phase is optional: an update-only target (a non-particle host) has no
  // spawn target.
  if (targets.spawn !== undefined) {
    const spawnView = buildPhaseView(graph, FXBehaviorPhase.SPAWN, phaseOf);
    errors.push(
      ...validateKernelTarget(targets.spawn, "spawn"),
      ...validateGraph(spawnView, targets.spawn).errors,
      ...detectOverlappingWrites(spawnView, targets.spawn),
      ...detectPhasePairErrors(targets.spawn, targets.update),
    );
  } else {
    // A reachable SPAWN node on an update-only target can never run - report it rather
    // than silently dropping the subgraph (the old "green status, no effect" trap).
    errors.push(...detectUnsupportedSpawnPhase(graph, reachable));
  }
  return { ok: errors.length === 0, errors };
}
