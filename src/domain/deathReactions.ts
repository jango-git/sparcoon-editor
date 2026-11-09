/**
 * Death reactions across a scene (see `EmitterDoc.reactions`): which emitters are sources, which
 * links may exist, and what being a source does to an emitter's simulation. The one place these
 * rules live - commands, the agent API, the timeline UI, persistence, the preview and the export
 * all ask here.
 *
 * A reaction is an edge from its source to the emitter it sits on. The edges never form a cycle
 * (an emitter reacting to itself included): a cycle would keep a scene spawning forever, one frame
 * per round.
 */

import type { DeathReaction, EmitterDoc, SceneModel } from "../model/editorState";
import type { SpawnSinkConfig } from "./sinkMeta";
import { readSpawnSinkConfig } from "./sinkMeta";

/** The ids of every emitter whose particles' deaths some reaction in `emitters` listens to. */
export function deathSourceIds(emitters: readonly EmitterDoc[]): ReadonlySet<string> {
  return new Set(emitters.flatMap((emitter) => emitter.reactions.map((r) => r.source)));
}

/** The emitters reacting to `sourceId`'s particles' deaths, in scene order. */
export function reactingEmitters(
  emitters: readonly EmitterDoc[],
  sourceId: string,
): readonly EmitterDoc[] {
  return emitters.filter((emitter) =>
    emitter.reactions.some((reaction) => reaction.source === sourceId),
  );
}

/**
 * Whether `targetId` may react to `sourceId`'s particles' deaths: both exist, and the new edge
 * closes no cycle - `targetId` does not already reach `sourceId` (itself included). `ignore` leaves
 * one existing reaction of `targetId` out, so a reaction can be re-pointed.
 */
export function canReact(
  emitters: readonly EmitterDoc[],
  targetId: string,
  sourceId: string,
  ignore?: string,
): boolean {
  const ids = new Set(emitters.map((emitter) => emitter.id));
  if (!ids.has(targetId) || !ids.has(sourceId)) {
    return false;
  }
  // Walk forward from the target along source -> reacting edges: reaching the source closes a cycle.
  const reached = new Set<string>([targetId]);
  const pending = [targetId];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (id === sourceId) {
      return false;
    }
    for (const emitter of emitters) {
      const reacts = emitter.reactions.some(
        (reaction) =>
          reaction.source === id && !(emitter.id === targetId && reaction.id === ignore),
      );
      if (reacts && !reached.has(emitter.id)) {
        reached.add(emitter.id);
        pending.push(emitter.id);
      }
    }
  }
  return true;
}

/** The emitters `targetId` may react to (see {@link canReact}), in scene order. */
export function reactionSourceCandidates(
  emitters: readonly EmitterDoc[],
  targetId: string,
  ignore?: string,
): readonly EmitterDoc[] {
  return emitters.filter((emitter) => canReact(emitters, targetId, emitter.id, ignore));
}

/**
 * `emitter`'s spawn-sink config as it actually runs: a death source never asks for the GPU - only
 * the CPU simulation sees its particles die. What the preview builds and the export compiles by.
 */
export function effectiveSpawnConfig(emitter: EmitterDoc, scene: SceneModel): SpawnSinkConfig {
  const config = readSpawnSinkConfig(emitter.behaviorGraph);
  return config.tryGpuSimulation && deathSourceIds(scene.emitters).has(emitter.id)
    ? { ...config, tryGpuSimulation: false }
    : config;
}

/**
 * `emitters` with every reaction that cannot stand dropped, in order: one whose source is gone,
 * and one closing a cycle with the reactions kept before it. For a document from outside the
 * editor's own commands (a file, a hand edit), which never produce either.
 */
export function withValidReactions(emitters: readonly EmitterDoc[]): readonly EmitterDoc[] {
  let kept = emitters.map((emitter) => ({ ...emitter, reactions: [] as DeathReaction[] }));
  for (const emitter of emitters) {
    for (const reaction of emitter.reactions) {
      if (canReact(kept, emitter.id, reaction.source)) {
        kept = kept.map((candidate) =>
          candidate.id === emitter.id
            ? { ...candidate, reactions: [...candidate.reactions, reaction] }
            : candidate,
        );
      }
    }
  }
  return kept.map((emitter, index) =>
    emitter.reactions.length === emitters[index]?.reactions.length ? emitters[index] : emitter,
  );
}
