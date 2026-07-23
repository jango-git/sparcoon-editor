import type { FXGraph } from "../core/FXGraph";
import type { FXRenderNode } from "../render/FXRenderNode";
import type { FXGeometrySource, FXRenderArtifact, FXRenderMode } from "sparcoon";
import type { FXCompilerError } from "../core/compiler/FXCompilerError";
import { FXCompilerBaseline } from "../render/compiler/FXCompilerBaseline";
import { FX_MESH_TARGET } from "../render/target/FXParticleRenderTarget";
import { collectLightingRequirements } from "../core/compiler/collectLightingRequirements";
import { assembleRenderArtifact } from "./assembleArtifacts";

/** Render-only sibling of {@link compileToArtifacts} for a VFX mesh: a single, non-instanced
 *  mesh with a render graph but no simulation, behavior graph, or per-particle attributes - the
 *  whole particle half is skipped. `attributeReads` is always empty. */
export interface FXCompileMeshOptions {
  /** The geometry the mesh renders: a built-in primitive or a custom mesh asset, named.
   *  @defaultValue `{ type: "primitive", primitive: "plane" }` */
  readonly geometry?: FXGeometrySource;
  /** How the mesh fragment composites into the framebuffer. @defaultValue `"blending"` */
  readonly renderMode?: FXRenderMode;
}

export interface FXCompiledMeshArtifact {
  readonly render: FXRenderArtifact;
  /** Structural hash (shader hash + renderMode + geometry). Equal across two compiles => the
   *  host can rebind (`applyUniformValues`) instead of rebuilding the material. */
  readonly hash: string;
}

export function compileMeshArtifact(
  renderGraph: FXGraph<FXRenderNode>,
  options: FXCompileMeshOptions = {},
): FXCompiledMeshArtifact {
  const shader = new FXCompilerBaseline().compile(renderGraph, FX_MESH_TARGET);
  const lightingIntrinsics = collectLightingRequirements(renderGraph);
  const renderMode = options.renderMode ?? "blending";
  const geometry: FXGeometrySource = options.geometry ?? { type: "primitive", primitive: "plane" };
  const render = assembleRenderArtifact(shader, lightingIntrinsics, geometry, [], renderMode);
  // renderMode/geometry reshape the runtime material, not the shader, so fold them into the hash
  // explicitly (mirrors compileToArtifacts) - toggling either counts as structural.
  return { render, hash: `${shader.hash}::rm-${renderMode}::geo-${JSON.stringify(geometry)}` };
}

/** Validates a mesh render graph against {@link FX_MESH_TARGET} without throwing. Reading a
 *  particle-only builtin surfaces here as an `unknown-target-input` error. */
export function validateMeshArtifact(
  renderGraph: FXGraph<FXRenderNode>,
): readonly FXCompilerError[] {
  return new FXCompilerBaseline().validate(renderGraph, FX_MESH_TARGET).errors;
}
