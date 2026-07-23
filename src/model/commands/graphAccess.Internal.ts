/**
 * Shared substrate every graph command builds on: resolves the active owner's graph for a slot,
 * and replaces it inside a fresh `SourceState`. Not part of `model/commands`'s public barrel -
 * only the sibling graph command modules import it.
 */

import { createEmptyGraph } from "../../domain/graphModel";
import type { EditorGraph, GraphOutputBinding } from "../../domain/graphModel";
import { GraphKind } from "../../domain/nodePalette";
import { resolveGraphOwner, type SourceState } from "../editorState";

/** Which authored graph a command targets. */
export type GraphSlot = "renderGraph" | "behaviorGraph";

export function kindForSlot(slot: GraphSlot): GraphKind {
  return slot === "renderGraph" ? GraphKind.Render : GraphKind.Behavior;
}

/**
 * The active owner's graph for `slot`. A VFX mesh is render-only, so its behavior slot resolves to
 * an empty graph, symmetric with {@link withGraph}'s no-op write - inert at this boundary, not just UI-hidden.
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
  return emitter[slot];
}

/**
 * Applies `update` to the active owner's `slot` graph, replacing just that owner. A VFX mesh's
 * behavior-slot write (attributes included) leaves the source unchanged - see {@link activeGraph}.
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
      emitters: source.scene.emitters.map((emitter) =>
        emitter.id === activeId ? { ...emitter, [slot]: update(emitter[slot]) } : emitter,
      ),
    },
  };
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
