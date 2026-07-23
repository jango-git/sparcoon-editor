/**
 * The render-only sibling of {@link EmitterView} for a VFX mesh: no behavior graph, no simulation,
 * no spawn. Drives a single `THREE.Mesh` from one {@link FXLiveGraph}, same structural-vs-rebind
 * gate and geometry/render-mode rebuild tracking as an emitter's.
 */

import type { BufferGeometry, Object3D, Texture } from "three";
import { FXMesh } from "sparcoon/editor";
import type { FXRenderArtifact } from "sparcoon";
import { FXGraphReconciler } from "../engine/core/live/FXGraphReconciler";
import { FXLiveGraph } from "../engine/core/live/FXLiveGraph";
import type { FXNodeRegistry } from "../engine/core/live/FXNodeRegistry";
import type { FXCompilerError } from "../engine/core/compiler/FXCompilerError";
import { paramUniformName } from "../engine/nodes-std/paramSupport.Internal";
import { compilerErrorMessage } from "../i18n/compilerErrors";
import type { FXCompiledShader } from "../engine/render/compiler/FXCompiledShader";
import type { FXGLSLRenderTier } from "../engine/render/compiler/FXRenderCompilers";
import { FXRenderLiveBackend } from "../engine/render/live/FXRenderLiveBackend";
import type { FXRenderNode } from "../engine/render/FXRenderNode";
import { FX_MESH_TARGET } from "../engine/render/target/FXParticleRenderTarget";
import { collectLightingRequirements } from "../engine/core/compiler/collectLightingRequirements";
import { assembleRenderArtifact } from "../engine/emit/assembleArtifacts";
import type { FXGraphSnapshotData } from "../engine/core/live/FXSnapshotData";
import {
  encodeGeometrySource,
  toArtifactGeometrySource,
  type GeometrySource,
  type RenderMode,
} from "../domain/nodePalette";
import type { LiveApplyStatus } from "../model/editorState";
import type { Transform } from "../model/transform";
import { createGizmoMarker, type GizmoMarker } from "./emitterMarker";
import { applyTransform, type TextureResolver } from "./emitterView";
import { externalSlots } from "./externalSlots";

const RECOMPILED: LiveApplyStatus = { status: "recompiled", messages: [] };
const REBOUND: LiveApplyStatus = { status: "rebound", messages: [] };

function invalid(messages: readonly string[]): LiveApplyStatus {
  return { status: "invalid", messages };
}

function invalidFromErrors(errors: readonly FXCompilerError[]): LiveApplyStatus {
  return {
    status: "invalid",
    messages: errors.map((error) => compilerErrorMessage(error)),
    errors,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class MeshView {
  private readonly renderLive: FXLiveGraph<FXRenderNode, FXCompiledShader>;
  private shader: FXCompiledShader | undefined = undefined;
  // The last assembled artifact, kept so a timeline value-drive can find each param's uniform slot
  // and its baked baseline (to revert a param that stops being driven).
  private artifact: FXRenderArtifact | undefined = undefined;

  private mesh: FXMesh | undefined = undefined;

  // The exact IR + runtime shape the current mesh was built from: geometry / renderMode reshape the
  // mesh+material but not the IR hash, so a change to either is invisible to the live gate.
  private builtShader: FXCompiledShader | undefined = undefined;
  private builtGeometryKey: string | undefined = undefined;
  // Only meaningful when the geometry source is "custom" - see EmitterView's field of the same name.
  private builtCustomGeometryReference: BufferGeometry | undefined = undefined;
  private builtRenderMode: RenderMode | undefined = undefined;
  // Surface-sink shadow flags (readRenderSinkConfig), invisible to the live gate's IR hash - track the
  // built values so a flip forces installMesh (which attaches/detaches the customDepthMaterial).
  private builtCastShadow = false;
  private builtReceiveShadow = false;

  private readonly drivenParams = new Set<string>();
  private lastTransform: Transform | undefined = undefined;
  // See EmitterView.lastVisible: re-asserted onto a freshly (re)built mesh so a rebuild never
  // flashes a muted mesh visible again.
  private lastVisible = true;
  private readonly marker: GizmoMarker = createGizmoMarker("vfxMesh");

  constructor(
    private readonly parent: Object3D,
    private readonly resolveTexture: TextureResolver,
    renderRegistry: FXNodeRegistry<FXRenderNode>,
    // Which GLSL tier this view's live render graph compiles with - see EmitterView's constructor.
    renderBackend: FXGLSLRenderTier,
    // The content library's live mesh geometries, by name - see EmitterView's constructor.
    private readonly resolveMeshGeometries: () => Readonly<
      Record<string, BufferGeometry>
    > = () => ({}),
  ) {
    this.renderLive = new FXLiveGraph(
      new FXGraphReconciler(renderRegistry),
      // Always the attribute-free mesh target: a `read-attribute` (or any particle-only node) then
      // fails validation against it - the palette restriction enforced by the compiler itself.
      new FXRenderLiveBackend(
        renderBackend,
        () => FX_MESH_TARGET,
        (compiled) => {
          this.shader = compiled;
        },
      ),
    );
  }

  /** The runtime mesh's Object3D (its transform is the mesh's pose), or `undefined` before build. */
  public get object3D(): Object3D | undefined {
    return this.mesh;
  }

  /** The gizmo's invisible pick proxy, raycast to select this mesh in the viewport. */
  public get pickTarget(): Object3D {
    return this.marker.pickTarget;
  }

  /** Reconciles the render snapshot and (re)builds or rebinds the mesh. `geometry` is the mesh
   * doc's own source, not the render sink's particle geometry. */
  public apply(
    renderSnapshot: FXGraphSnapshotData,
    geometry: GeometrySource,
    renderMode: RenderMode,
    castShadow: boolean,
    receiveShadow: boolean,
  ): LiveApplyStatus {
    const result = this.renderLive.apply(renderSnapshot);
    if (result.status === "invalid") {
      return invalidFromErrors(result.errors);
    }
    if (this.shader === undefined) {
      return invalid(["MeshView: no compiled IR after a valid apply"]);
    }

    let artifact: FXRenderArtifact;
    try {
      artifact = assembleRenderArtifact(
        this.shader,
        collectLightingRequirements(this.renderLive.graphView),
        toArtifactGeometrySource(geometry),
        [],
        renderMode,
      );
    } catch (error) {
      return invalid([describeError(error)]);
    }
    this.artifact = artifact;

    const geometryKey = encodeGeometrySource(geometry);
    const currentCustomGeometryReference =
      geometry.kind === "custom" ? this.resolveMeshGeometries()[geometry.meshAssetName] : undefined;
    const structural =
      result.status === "recompiled" ||
      this.mesh === undefined ||
      geometryKey !== this.builtGeometryKey ||
      // A "custom" reference whose bound mesh asset was deleted or re-uploaded - see EmitterView.
      currentCustomGeometryReference !== this.builtCustomGeometryReference ||
      renderMode !== this.builtRenderMode ||
      // Shadow flags reshape the runtime mesh (attach/detach the depth material), not the IR.
      castShadow !== this.builtCastShadow ||
      receiveShadow !== this.builtReceiveShadow ||
      this.shader !== this.builtShader;

    if (structural) {
      try {
        this.installMesh(artifact, castShadow, receiveShadow);
      } catch (error) {
        return invalid([describeError(error)]);
      }
      this.builtShader = this.shader;
      this.builtGeometryKey = geometryKey;
      this.builtCustomGeometryReference = currentCustomGeometryReference;
      this.builtRenderMode = renderMode;
      this.builtCastShadow = castShadow;
      this.builtReceiveShadow = receiveShadow;
      return RECOMPILED;
    }

    // Value-only edit: scrub the fresh uniform values into the running material's slots by name.
    this.mesh?.applyValues(this.uniformValues(artifact));
    return REBOUND;
  }

  /**
   * Scrubs the timeline's sampled render-param values into the running material for this frame. A
   * param dropped since last frame reverts to its baked baseline. No-op until a mesh exists.
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

  /** Highlights this mesh's preview gizmo as the selected one (accent tint), or not. */
  public setSelected(selected: boolean): void {
    this.marker.setSelected(selected);
  }

  /** Poses the running mesh's Object3D. Cached so a later rebuild keeps the pose. */
  public applyTransform(transform: Transform): void {
    this.lastTransform = transform;
    if (this.mesh !== undefined) {
      applyTransform(this.mesh, transform);
    }
  }

  /** Shows/hides the mesh in the preview (the outline's mute toggle). Cached like the pose. */
  public setVisible(visible: boolean): void {
    this.lastVisible = visible;
    if (this.mesh !== undefined) {
      this.mesh.visible = visible;
    }
  }

  public destroy(): void {
    this.marker.object.removeFromParent();
    this.marker.dispose();
    this.disposeMesh();
    this.artifact = undefined;
    this.drivenParams.clear();
    this.renderLive.destroy();
  }

  /** Replaces the running mesh with a fresh one for the new artifact. May throw (see caller). */
  private installMesh(
    artifact: FXRenderArtifact,
    castShadow: boolean,
    receiveShadow: boolean,
  ): void {
    const textures: Record<string, Texture> = {};
    for (const slot of externalSlots(artifact)) {
      textures[paramUniformName(slot.paramName)] = this.resolveTexture(slot.paramName);
    }
    // Build the new mesh BEFORE dropping the old one, so a throw leaves the last good preview up.
    // FXMesh resolves its own geometry from artifact.geometry, self-registers with the default
    // FXWorld, and is ticked from there (clock + object velocity/angular velocity for a render graph
    // reading those builtins) - no manual setClock, no manual geometry resolution.
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

  /** The live uniform values (numbers + external textures) to scrub into the running material. */
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
