/**
 * Shared substrate every graph command builds on: resolves the active owner's graph for a slot,
 * and replaces it inside a fresh `SourceState`. Not part of `model/commands`'s public barrel -
 * only the sibling graph command modules import it.
 */

import type { EditorGraph, GraphOutputBinding } from "../../domain/graphModel";
import { createEmptyGraph } from "../../domain/graphModel";
import { resolveGraphOwner, type SourceState } from "../editorState";
import { GRAPH_SLOTS, type GraphSlot, STRIP_NAMES } from "../graphSlots";

export { type GraphSlot, kindForSlot } from "../graphSlots";

/**
 * The active owner's graph for `slot`. A VFX mesh is render-only, so its behavior slot resolves to
 * an empty graph, symmetric with {@link withGraph}'s no-op write - inert at this boundary, not just
 * UI-hidden. An emitter's trail or ribbon slot throws while that strip is off: unlike a mesh's
 * behavior slot, that graph can exist, so an edit aimed at it must not silently vanish (turn the
 * strip on with `setEmitterStrip` first).
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
    throw new Error(missingStripMessage(emitter.name, slot));
  }
  return graph;
}

function missingStripMessage(emitterName: string, slot: GraphSlot): string {
  const strip = STRIP_NAMES.find((name) => GRAPH_SLOTS[name].slot === slot) ?? slot;
  return `Emitter "${emitterName}" has no ${strip} graph - turn its ${strip} on first`;
}

/**
 * Applies `update` to the active owner's `slot` graph, replacing just that owner. A VFX mesh's
 * behavior-slot write (attributes included) leaves the source unchanged, while a write to a strip
 * of an emitter whose strip is off throws - see {@link activeGraph}.
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
          throw new Error(missingStripMessage(emitter.name, slot));
        }
        return { ...emitter, [slot]: update(graph) };
      }),
    },
  };
}

/** Whether the active owner authors a `slot` graph: a mesh only its render graph, an emitter its
 *  render and behavior graphs, and its trail and ribbon graphs while they are on. */
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
