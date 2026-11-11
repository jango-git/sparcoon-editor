/**
 * The longest lifetime a particle of an emitter can be born with, which the runtime settles an
 * emitter by (`FXEmitterOptions.maxLifetime`). Lifetime is written at birth only and Kill only
 * shortens it, so a bound read off the spawn binding holds for the particle's whole life. Shared by
 * the live preview's warning and the export, so the two agree on which emitters have one.
 */

import type { FXCompilerError } from "../engine/core/compiler/FXCompilerError";
import type { FXGraphSnapshotData } from "../engine/core/live/FXSnapshotData";
import { fxLifetime } from "../engine/nodes-std/behavior/spawn";
import { SPAWN_SINK_ID } from "./sinkMeta";

const LIFETIME_SLOT = "lifetime";

/**
 * The bound, from a serialized behavior graph (routes already spliced out): the larger of a
 * Lifetime node's min and max when both are typed in, not wired. `undefined` for anything else -
 * a graph or parameter feeding the lifetime has no bound that can be read off it.
 */
export function lifetimeUpperBound(behavior: FXGraphSnapshotData): number | undefined {
  const binding = behavior.outputBindings.find(
    (candidate) => candidate.slot === LIFETIME_SLOT && candidate.phase === "spawn",
  );
  if (binding === undefined) {
    return undefined;
  }
  const nodeId = binding.from.nodeId;
  const node = behavior.nodes[nodeId];
  if (
    node?.type !== fxLifetime.type ||
    behavior.connections.some((connection) => connection.to.nodeId === nodeId)
  ) {
    return undefined;
  }
  const min = node.params?.["min"];
  const max = node.params?.["max"];
  if (!isLifetime(min) || !isLifetime(max)) {
    return undefined;
  }
  return Math.max(min, max);
}

/** A warning when an emitter has no bound: its exported effect never dispatches `"drained"`. */
export function unboundedLifetimeWarnings(behavior: FXGraphSnapshotData): FXCompilerError[] {
  return lifetimeUpperBound(behavior) === undefined
    ? [
        {
          code: "lifetime-unbounded",
          message:
            "the longest particle lifetime cannot be told from this graph, so an exported effect " +
            'with this emitter never dispatches "drained" - feed the spawn sink\'s Lifetime from a ' +
            "Lifetime node with Min and Max typed in",
          nodeId: SPAWN_SINK_ID,
        },
      ]
    : [];
}

function isLifetime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
