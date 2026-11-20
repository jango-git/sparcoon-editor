/**
 * Preview of a VFX mesh, one `THREE.Mesh` driven by one {@link FXLiveGraph}. No behavior graph,
 * simulation or spawn.
 */

import type { FXRenderArtifact } from "sparcoon";
import { FXMesh } from "sparcoon/editor";
import type { BufferGeometry, Object3D, Texture, WebGLRenderer } from "three";

import { meshTransformWarnings } from "../domain/meshDiagnostics";
import {
  encodeGeometrySource,
  type GeometrySource,
  type RenderMode,
  toArtifactGeometrySource,
} from "../domain/nodePalette";
import {
  meshRenderBudgetFindings,
  type RenderBudgetFindings,
  RenderBudgetMemo,
} from "../domain/renderBudget";
import { depthFadeModeErrors } from "../domain/sceneDepthChecks";
import { FXGraphReconciler } from "../engine/core/live/FXGraphReconciler";
import { FXLiveGraph } from "../engine/core/live/FXLiveGraph";
import type { FXNodeRegistry } from "../engine/core/live/FXNodeRegistry";
import type { FXGraphSnapshotData } from "../engine/core/live/FXSnapshotData";
import { assembleRenderArtifact } from "../engine/emit/assembleArtifacts";
import { paramUniformName } from "../engine/nodes-std/paramSupport.Internal";
import type { FXCompiledShader } from "../engine/render/compiler/FXCompiledShader";
import type { FXGLSLRenderTier } from "../engine/render/compiler/FXRenderCompilers";
import type { FXRenderNode } from "../engine/render/FXRenderNode";
import { FXRenderLiveBackend } from "../engine/render/live/FXRenderLiveBackend";
import { buildMeshTarget } from "../engine/render/target/FXParticleRenderTarget";
import type { LiveApplyStatus } from "../model/editorState";
import type { Transform } from "../model/transform";
import {
  invalid,
  invalidFromErrors,
  REBOUND,
  RECOMPILED,
  withWarnings,
} from "./applyStatus.Internal";
import { createGizmoMarker, type GizmoMarker } from "./emitterMarker";
import { applyTransform, type TextureResolver } from "./emitterView";
import { everyTierShaders } from "./everyTierShaders";
import { externalSlots } from "./externalSlots";
import { type ProgramLinkFailures, programLinkFailures } from "./programLinkFailures";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class MeshView {
  private readonly budget = new RenderBudgetMemo();
  private readonly renderLive: FXLiveGraph<FXRenderNode, FXCompiledShader>;
  private readonly renderRegistry: FXNodeRegistry<FXRenderNode>;
  private readonly renderBackend: FXGLSLRenderTier;
  private shader: FXCompiledShader | undefined = undefined;
  // The last assembled artifact. Value drive reads each param's uniform slot and baked baseline
  // from it.
  private artifact: FXRenderArtifact | undefined = undefined;

  private mesh: FXMesh | undefined = undefined;

  // What the mesh was built from. Geometry and render mode reshape the mesh but not the IR hash, so
  // only this detects their change.
  private builtShader: FXCompiledShader | undefined = undefined;
  private builtGeometryKey: string | undefined = undefined;
  private builtCustomGeometryReference: BufferGeometry | undefined = undefined;
  private builtRenderMode: RenderMode | undefined = undefined;
  // Shadow flags as built. Not in the IR hash, so a flip must force `installMesh`.
  private builtCastShadow = false;
  // Cast-shadow flag of the current apply. The shadow program compiles only when it is set.
  private currentCastShadow = false;
  private builtReceiveShadow = false;

  private readonly drivenParams = new Set<string>();
  private lastTransform: Transform | undefined = undefined;
  // Reapplied to a rebuilt mesh so a muted mesh stays hidden.
  private lastVisible = true;
  private readonly marker: GizmoMarker = createGizmoMarker("vfxMesh");

  constructor(
    private readonly parent: Object3D,
    private readonly resolveTexture: TextureResolver,
    renderRegistry: FXNodeRegistry<FXRenderNode>,
    renderBackend: FXGLSLRenderTier,
    private readonly resolveMeshGeometries: () => Readonly<
      Record<string, BufferGeometry>
    > = () => ({}),
  ) {
    this.renderLive = new FXLiveGraph(
      new FXGraphReconciler(renderRegistry),
      // Attribute-free mesh target, so particle-only nodes such as `custom-attribute` fail
      // validation.
      new FXRenderLiveBackend(
        renderBackend,
        () => buildMeshTarget(this.currentCastShadow),
        (compiled) => {
          this.shader = compiled;
        },
      ),
    );
    this.renderRegistry = renderRegistry;
    this.renderBackend = renderBackend;
  }

  public get object3D(): Object3D | undefined {
    return this.mesh;
  }

  public get visible(): boolean {
    return this.lastVisible;
  }

  public get readsSceneDepth(): boolean {
    return this.mesh !== undefined && this.artifact?.sceneDepth === true;
  }

  public get pickTarget(): Object3D {
    return this.marker.pickTarget;
  }

  /** `geometry` is the mesh document's source, not the render sink's particle geometry. */
  public apply(
    renderSnapshot: FXGraphSnapshotData,
    geometry: GeometrySource,
    renderMode: RenderMode,
    castShadow: boolean,
    receiveShadow: boolean,
  ): LiveApplyStatus {
    this.currentCastShadow = castShadow;
    const result = this.renderLive.apply(renderSnapshot);
    if (result.status === "invalid") {
      return invalidFromErrors(result.errors);
    }
    const depthFadeErrors = depthFadeModeErrors(this.renderLive.graphView, renderMode);
    if (depthFadeErrors.length > 0) {
      return invalidFromErrors(depthFadeErrors);
    }
    if (this.shader === undefined) {
      return invalid(["MeshView: no compiled IR after a valid apply"]);
    }

    let artifact: FXRenderArtifact;
    try {
      artifact = assembleRenderArtifact(
        this.shader,
        toArtifactGeometrySource(geometry),
        [],
        renderMode,
      );
    } catch (error) {
      return invalid([describeError(error)]);
    }

    let budget: RenderBudgetFindings;
    try {
      const shader = this.shader;
      budget = this.budget.get([shader, renderMode, castShadow], () => {
        const shaders = everyTierShaders({
          tier: this.renderBackend,
          shader,
          snapshot: renderSnapshot,
          registry: this.renderRegistry,
          buildTarget: () => buildMeshTarget(castShadow),
        });
        const assemble = (compiled: FXCompiledShader): FXRenderArtifact =>
          compiled === shader
            ? artifact
            : assembleRenderArtifact(compiled, toArtifactGeometrySource(geometry), [], renderMode);
        return meshRenderBudgetFindings(
          { baseline: assemble(shaders.baseline), standard: assemble(shaders.standard) },
          castShadow,
        );
      });
    } catch (error) {
      return invalid([describeError(error)]);
    }
    if (budget.errors.length > 0) {
      return invalidFromErrors(budget.errors);
    }
    const warnings = [...budget.warnings, ...meshTransformWarnings(this.renderLive.graphView)];

    const geometryKey = encodeGeometrySource(geometry);
    const currentCustomGeometryReference =
      geometry.kind === "custom" ? this.resolveMeshGeometries()[geometry.meshAssetName] : undefined;
    const structural =
      result.status === "recompiled" ||
      this.mesh === undefined ||
      geometryKey !== this.builtGeometryKey ||
      currentCustomGeometryReference !== this.builtCustomGeometryReference ||
      renderMode !== this.builtRenderMode ||
      castShadow !== this.builtCastShadow ||
      receiveShadow !== this.builtReceiveShadow ||
      this.shader !== this.builtShader;

    if (structural) {
      try {
        this.installMesh(artifact, castShadow, receiveShadow);
      } catch (error) {
        return invalid([describeError(error)]);
      }
      this.artifact = artifact;
      this.builtShader = this.shader;
      this.builtGeometryKey = geometryKey;
      this.builtCustomGeometryReference = currentCustomGeometryReference;
      this.builtRenderMode = renderMode;
      this.builtCastShadow = castShadow;
      this.builtReceiveShadow = receiveShadow;
      return withWarnings(RECOMPILED, warnings);
    }

    this.mesh?.applyValues(this.uniformValues(artifact));
    this.artifact = artifact;
    return withWarnings(REBOUND, warnings);
  }

  /**
   * Writes sampled timeline values into the material. A param no longer driven reverts to its baked
   * baseline.
   */
  public driveParamValues(values: ReadonlyMap<string, number | readonly number[]>): void {
    if (this.mesh === undefined || this.artifact === undefined) {
      return;
    }
    const uniforms: Record<string, number | readonly number[] | Texture> = {};
    for (const [name, value] of values) {
      const key = paramUniformName(name);
      if (key in this.artifact.uniforms) {
        uniforms[key] = value;
        this.drivenParams.add(name);
      }
    }
    for (const name of [...this.drivenParams]) {
      if (!values.has(name)) {
        const key = paramUniformName(name);
        const init = this.artifact.uniforms[key];
        if (init !== undefined && "value" in init) {
          uniforms[key] = init.value;
        }
        this.drivenParams.delete(name);
      }
    }
    if (Object.keys(uniforms).length > 0) {
      this.mesh.applyValues(uniforms);
    }
  }

  public setSelected(selected: boolean): void {
    this.marker.setSelected(selected);
  }

  public applyTransform(transform: Transform): void {
    this.lastTransform = transform;
    if (this.mesh !== undefined) {
      applyTransform(this.mesh, transform);
    }
  }

  public setVisible(visible: boolean): void {
    this.lastVisible = visible;
    if (this.mesh !== undefined) {
      this.mesh.visible = visible;
    }
  }

  public programLinkFailures(renderer: WebGLRenderer): ProgramLinkFailures {
    return this.mesh === undefined
      ? {}
      : programLinkFailures(renderer, this.mesh, () => "render", this.marker.object);
  }

  public destroy(): void {
    this.marker.object.removeFromParent();
    this.marker.dispose();
    this.disposeMesh();
    this.artifact = undefined;
    this.drivenParams.clear();
    this.renderLive.destroy();
  }

  private installMesh(
    artifact: FXRenderArtifact,
    castShadow: boolean,
    receiveShadow: boolean,
  ): void {
    const textures: Record<string, Texture> = {};
    for (const slot of externalSlots(artifact)) {
      textures[paramUniformName(slot.paramName)] = this.resolveTexture(slot.paramName);
    }
    // Build the new mesh before dropping the old one, so a throw keeps the last good preview.
    // FXMesh resolves its geometry and registers with the default FXWorld itself.
    const next = FXMesh.fromArtifact(artifact, {
      textures,
      geometries: this.resolveMeshGeometries(),
      castShadow,
      receiveShadow,
    });
    this.disposeMesh();
    this.mesh = next;
    this.parent.add(next);
    next.add(this.marker.object);
    if (this.lastTransform !== undefined) {
      applyTransform(next, this.lastTransform);
    }
    next.visible = this.lastVisible;
  }

  private uniformValues(
    artifact: FXRenderArtifact,
  ): Record<string, number | readonly number[] | Texture> {
    const uniforms: Record<string, number | readonly number[] | Texture> = {};
    for (const [name, init] of Object.entries(artifact.uniforms)) {
      if ("value" in init) {
        uniforms[name] = init.value;
      }
    }
    for (const slot of externalSlots(artifact)) {
      uniforms[slot.uniformName] = this.resolveTexture(slot.paramName);
    }
    return uniforms;
  }

  private disposeMesh(): void {
    this.mesh?.destroy();
    this.mesh = undefined;
  }
}
