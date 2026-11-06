/**
 * Warnings about a VFX mesh's render graph that do not stop it from running but would surprise its
 * author.
 */

import { collectSlotReads } from "../engine/core/compiler/collectSlotReads";
import type { FXCompilerError } from "../engine/core/compiler/FXCompilerError";
import type { FXGraph } from "../engine/core/FXGraph";
import type { FXGraphNode } from "../engine/core/FXGraphNode";

/** The render outputs a mesh material places its vertices with (see the runtime's mesh material). */
const TRANSFORM_SLOTS: readonly string[] = ["particleTransform", "vertexTransform"];

const IGNORES_TRANSFORM: FXCompilerError = {
  code: "mesh-ignores-transform",
  message:
    "this mesh never reads its world matrix, so its transform, its keyframes and the effect's " +
    "placement do not move it - wire a World Matrix node into Vertex Transform",
};

/**
 * A mesh material projects from the render graph's own transform outputs, never from the object's
 * matrix - so a mesh whose transform outputs never read `modelMatrix` stays where its vertices
 * are, unmoved by its transform, its keyframes and the effect's placement in the host scene alike.
 * Reading it elsewhere (to tint by world position, say) moves nothing, so only those outputs count.
 */
export function meshTransformWarnings(graph: FXGraph<FXGraphNode>): readonly FXCompilerError[] {
  return collectSlotReads(graph, TRANSFORM_SLOTS).has("modelMatrix") ? [] : [IGNORES_TRANSFORM];
}
