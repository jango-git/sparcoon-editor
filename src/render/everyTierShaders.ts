import { FXGraph } from "../engine/core/FXGraph";
import { collectAttributeRequests } from "../engine/core/compiler/collectAttributeRequests";
import type { FXAttributeRequest } from "../engine/core/socket/FXAttribute";
import { FXGraphReconciler } from "../engine/core/live/FXGraphReconciler";
import type { FXNodeRegistry } from "../engine/core/live/FXNodeRegistry";
import type { FXGraphSnapshotData } from "../engine/core/live/FXSnapshotData";
import type { FXCompiledShader } from "../engine/render/compiler/FXCompiledShader";
import type { FXGLSLRenderTier } from "../engine/render/compiler/FXRenderCompilers";
import { FX_GLSL_RENDER_COMPILERS } from "../engine/render/compiler/FXRenderCompilers";
import type { FXRenderNode } from "../engine/render/FXRenderNode";
import type { FXTarget } from "../engine/render/target/FXTarget";

/** What a preview compiled for its own tier, and how to compile the same graph again. */
export interface FXPreviewCompile {
  readonly tier: FXGLSLRenderTier;
  readonly shader: FXCompiledShader;
  /** The snapshot the preview compiled from. */
  readonly snapshot: FXGraphSnapshotData;
  readonly registry: FXNodeRegistry<FXRenderNode>;
  readonly buildTarget: (attributes: readonly FXAttributeRequest[]) => FXTarget;
}

/**
 * The preview's graph compiled by every GLSL tier, as the export ships it: the preview's own
 * shader for its tier, a fresh compile for the other - each tier lifts what it can afford, so its
 * budget is counted on its own shader. The other compile builds nodes of its own from the
 * snapshot: a node keeps the handles its last compile gave it, so compiling the live graph again
 * would leave its value edits writing into that compile instead of the preview's. Where the other
 * tier cannot compile the graph, the preview's shader stands for both: the preview runs, and the
 * export reports the failure.
 */
export function everyTierShaders(
  preview: FXPreviewCompile,
): Readonly<Record<FXGLSLRenderTier, FXCompiledShader>> {
  const other: FXGLSLRenderTier = preview.tier === "standard" ? "baseline" : "standard";
  let compiled = preview.shader;
  const graph = new FXGraph<FXRenderNode>();
  try {
    const { errors } = new FXGraphReconciler(preview.registry).reconcile(graph, preview.snapshot);
    if (errors.length === 0) {
      compiled = FX_GLSL_RENDER_COMPILERS[other].compile(
        graph,
        preview.buildTarget(collectAttributeRequests(graph).requests),
      );
    }
  } catch {
    // Not compilable by the other tier: see above.
  } finally {
    // Only counted, never drawn: what its nodes hold goes with them.
    for (const node of graph.nodes.values()) {
      node.destroy?.();
    }
  }
  return other === "standard"
    ? { baseline: preview.shader, standard: compiled }
    : { baseline: compiled, standard: preview.shader };
}
