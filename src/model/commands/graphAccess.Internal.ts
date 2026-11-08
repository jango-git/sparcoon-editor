/**
 * Shared substrate every graph command builds on: resolves the active owner's graph for a slot,
 * and replaces it inside a fresh `SourceState`. Not part of `model/commands`'s public barrel -
 * only the sibling graph command modules import it.
 */

import { createEmptyGraph } from "../../domain/graphModel";
import type { EditorGraph, GraphOutputBinding } from "../../domain/graphModel";
import { resolveGraphOwner, type SourceState } from "../editorState";
import type { GraphSlot } from "../graphSlots";

export { kindForSlot, type GraphSlot } from "../graphSlots";

/**
 * The active owner's graph for `slot`. A VFX mesh is render-only, so its behavior slot resolves to
 * an empty graph, symmetric with {@link withGraph}'s no-op write - inert at this boundary, not just
 * UI-hidden. An emitter's trail slot throws while its trail is off: unlike a mesh's behavior slot,
 * that graph can exist, so an edit aimed at it must not silently vanish (turn the trail on with
 * `setEmitterTrail` first).
 */
export function activeGraph(source: SourceState, slot: GraphSlot): EditorGraph {
  const owner = resolveGraphOwner(source.scene);
  if (owner === undefined) {
    throw new Error("Scene has no graph owner");
  }
  if (owner.kind === "vfxMesh") {
    if (slot !== "renderGraph") {
      return createEmptyGraph();
    }
    const mesh = source.scene.meshes.find((candidate) => candidate.id === owner.id);
    if (mesh === undefined) {
      throw new Error("Active mesh missing");
    }
    return mesh.renderGraph;
  }
  const emitter = source.scene.emitters.find((candidate) => candidate.id === owner.id);
  if (emitter === undefined) {
    throw new Error("Scene has no emitters");
  }
  const graph = emitter[slot];
  if (graph === undefined) {
    throw new Error(missingTrailMessage(emitter.name));
  }
  return graph;
}

function missingTrailMessage(emitterName: string): string {
  return `Emitter "${emitterName}" has no trail graph - turn its trail on first`;
}

/**
 * Applies `update` to the active owner's `slot` graph, replacing just that owner. A VFX mesh's
 * behavior-slot write (attributes included) leaves the source unchanged, while a write to the
 * trail of an emitter whose trail is off throws - see {@link activeGraph}.
 */
export function withGraph(
  source: SourceState,
  slot: GraphSlot,
  update: (graph: EditorGraph) => EditorGraph,
): SourceState {
  const owner = resolveGraphOwner(source.scene);
  if (owner?.kind === "vfxMesh") {
    if (slot !== "renderGraph") {
      return source;
    }
    return {
      ...source,
      scene: {
        ...source.scene,
        meshes: source.scene.meshes.map((mesh) =>
          mesh.id === owner.id ? { ...mesh, renderGraph: update(mesh.renderGraph) } : mesh,
        ),
      },
    };
  }
  const activeId = owner?.id;
  return {
    ...source,
    scene: {
      ...source.scene,
      emitters: source.scene.emitters.map((emitter) => {
        if (emitter.id !== activeId) {
          return emitter;
        }
        const graph = emitter[slot];
        if (graph === undefined) {
          throw new Error(missingTrailMessage(emitter.name));
        }
        return { ...emitter, [slot]: update(graph) };
      }),
    },
  };
}

/** Whether the active owner authors a `slot` graph: a mesh only its render graph, an emitter its
 *  render and behavior graphs, and its trail graph while its trail is on. */
export function activeOwnerHasGraph(source: SourceState, slot: GraphSlot): boolean {
  const owner = resolveGraphOwner(source.scene);
  if (owner?.kind === "vfxMesh") {
    return slot === "renderGraph";
  }
  return source.scene.emitters.find((emitter) => emitter.id === owner?.id)?.[slot] !== undefined;
}

/** Whether the active graph owner has a behavior graph - only an emitter does (a mesh is render-only). */
export function activeOwnerHasBehaviorGraph(source: SourceState): boolean {
  return resolveGraphOwner(source.scene)?.kind === "emitter";
}

/**
 * True when `binding` addresses `slot` in `phase` - the pair is a binding's identity (behavior's
 * two phase sinks share slot names, so phase disambiguates; on render `phase` is absent).
 */
export function bindingMatches(
  binding: Pick<GraphOutputBinding, "slot" | "phase">,
  slot: string,
  phase: "spawn" | "update" | undefined,
): boolean {
  return binding.slot === slot && binding.phase === phase;
}
