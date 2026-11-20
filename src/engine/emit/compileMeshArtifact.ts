import type { FXGeometrySource, FXRenderArtifact, FXRenderMode } from "sparcoon";

import type { FXCompilerError } from "../core/compiler/FXCompilerError";
import type { FXGraph } from "../core/FXGraph";
import { FXCompilerBaseline } from "../render/compiler/FXCompilerBaseline";
import type { FXRenderNode } from "../render/FXRenderNode";
import { FX_MESH_TARGET } from "../render/target/FXParticleRenderTarget";
import { assembleRenderArtifact } from "./assembleArtifacts";

/**
 * Compiles the render graph of a VFX mesh: one non-instanced mesh, no simulation or attributes
 * (`attributeReads` is empty).
 */
export interface FXCompileMeshOptions {
  /** The geometry the mesh renders: a built-in primitive or a custom mesh asset, named.
   *  @defaultValue `{ type: "primitive", primitive: "plane" }` */
  readonly geometry?: FXGeometrySource;
  /** How the mesh fragment composites into the framebuffer. @defaultValue `"blending"` */
  readonly renderMode?: FXRenderMode;
}

export interface FXCompiledMeshArtifact {
  readonly render: FXRenderArtifact;
  /** Shader hash plus renderMode and geometry. Equal hashes allow a rebind instead of a rebuild. */
  readonly hash: string;
}

export function compileMeshArtifact(
  renderGraph: FXGraph<FXRenderNode>,
  options: FXCompileMeshOptions = {},
): FXCompiledMeshArtifact {
  const shader = new FXCompilerBaseline().compile(renderGraph, FX_MESH_TARGET);
  const renderMode = options.renderMode ?? "blending";
  const geometry: FXGeometrySource = options.geometry ?? { type: "primitive", primitive: "plane" };
  const render = assembleRenderArtifact(shader, geometry, [], renderMode);
  return { render, hash: `${shader.hash}::rm-${renderMode}::geo-${JSON.stringify(geometry)}` };
}

/**
 * Validates against FX_MESH_TARGET without throwing. A particle-only builtin read is an
 * `unknown-target-input` error.
 */
export function validateMeshArtifact(
  renderGraph: FXGraph<FXRenderNode>,
): readonly FXCompilerError[] {
  return new FXCompilerBaseline().validate(renderGraph, FX_MESH_TARGET).errors;
}
