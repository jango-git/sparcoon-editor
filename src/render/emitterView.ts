/**
 * Turns the two authored graphs into artifacts and runs them through the runtime executor - the
 * editor's own live gate (the runtime has none), deciding structural rebuild vs value-only rebind.
 */

import type { BufferGeometry, Camera, Object3D, Texture, WebGLRenderer } from "three";
import { FXEmitter } from "sparcoon/editor";
import type { FXApplyValues } from "sparcoon/editor";
import type { FXBehaviorArtifact, FXParticleKernelArtifact, FXRenderArtifact } from "sparcoon";
import { FXGraphReconciler } from "../engine/core/live/FXGraphReconciler";
import { FXLiveGraph } from "../engine/core/live/FXLiveGraph";
import type { FXNodeRegistry } from "../engine/core/live/FXNodeRegistry";
import {
  collectAttributeRequests,
  mergeAttributeCollections,
} from "../engine/core/compiler/collectAttributeRequests";
import type { FXCompilerError } from "../engine/core/compiler/FXCompilerError";
import {
  PARAM_COMPONENTS,
  paramBindingName,
  paramUniformName,
} from "../engine/nodes-std/paramSupport.Internal";
import { compilerErrorMessage } from "../i18n/compilerErrors";
import type { FXAttributeRequest } from "../engine/core/socket/FXAttribute";
import type { FXBehaviorNode } from "../engine/behavior/FXBehaviorNode";
import type { FXCompiledKernel } from "../engine/behavior/FXCompiledKernel";
import type { FXCompiledBehaviorBundle } from "../engine/behavior/FXCompiledBehaviorBundle";
import type { FXFusedProgramStandard } from "../engine/behavior/FXKernelBuildStandard.Internal";
import { FXBehaviorLiveBackend } from "../engine/behavior/live/FXBehaviorLiveBackend";
import { buildParticleBehaviorTargets } from "../engine/behavior/FXParticleBehaviorTarget";
import type { FXCompiledShader } from "../engine/render/compiler/FXCompiledShader";
import type { FXGLSLRenderTier } from "../engine/render/compiler/FXRenderCompilers";
import { FXRenderLiveBackend } from "../engine/render/live/FXRenderLiveBackend";
import type { FXRenderNode } from "../engine/render/FXRenderNode";
import { buildParticleTarget } from "../engine/render/target/FXParticleRenderTarget";
import { collectLightingRequirements } from "../engine/core/compiler/collectLightingRequirements";
import {
  assembleBehaviorArtifact,
  assembleGpuKernelArtifact,
  assembleRenderArtifact,
} from "../engine/emit/assembleArtifacts";
import type { FXGraphSnapshotData } from "../engine/core/live/FXSnapshotData";
import type { EditorAttribute } from "../domain/graphModel";
import {
  encodeGeometrySource,
  toArtifactGeometrySource,
  type RenderMode,
  type RenderSinkConfig,
  type SpawnSinkConfig,
} from "../domain/nodePalette";
import { undeclaredAttributeErrors } from "../domain/serialize";
import type { LiveApplyStatus } from "../model/editorState";
import type { Transform } from "../model/transform";
import { normalizeQuat } from "../model/transform";
import type { GraphApplier, GraphApplyResult } from "../model/pipeline";
import { createGizmoMarker, type GizmoMarker } from "./emitterMarker";
import { externalSlots } from "./externalSlots";

/** Resolves a Texture node's name to a live Three texture (or a fallback). */
export type TextureResolver = (paramName: string) => Texture;

/** The runnable artifact pair assembled from the two live graphs' compiled IR. */
interface PreviewArtifacts {
  readonly render: FXRenderArtifact;
  readonly behavior: FXBehaviorArtifact;
  readonly gpuBehavior?: FXParticleKernelArtifact;
}

const RECOMPILED: LiveApplyStatus = { status: "recompiled", messages: [] };
const REBOUND: LiveApplyStatus = { status: "rebound", messages: [] };
const BLOCKED: LiveApplyStatus = {
  status: "invalid",
  messages: ["blocked by an error in the other graph"],
};

function invalid(messages: readonly string[]): LiveApplyStatus {
  return { status: "invalid", messages };
}

/** An invalid status that carries the node-attributed problems, so the canvas can highlight them. */
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

export class EmitterView implements GraphApplier {
  private readonly renderLive: FXLiveGraph<FXRenderNode, FXCompiledShader>;
  private readonly behaviorLive: FXLiveGraph<FXBehaviorNode, FXCompiledBehaviorBundle>;
  private emitter: FXEmitter | undefined = undefined;

  // Latest installed IR + the attribute set it was compiled over (captured on each install).
  private shader: FXCompiledShader | undefined = undefined;
  private kernel: FXCompiledKernel | undefined = undefined;
  // The "standard" (GLSL/transform-feedback) family's own compiled program - undefined when the
  // flag is off or that family failed to compile this graph (FXCompiledBehaviorBundle.
  // standardProgram, unwrapped here the same way this.kernel unwraps bundle.kernel).
  private standardProgram: FXFusedProgramStandard | undefined = undefined;
  private renderAttributes: readonly FXAttributeRequest[] = [];
  private behaviorAttributes: readonly FXAttributeRequest[] = [];

  // Kept so the timeline value-drive can find each param's slot names and baked baseline (to
  // revert a param that stops being driven); reassembled every apply, no re-compile.
  private artifacts: PreviewArtifacts | undefined = undefined;

  // The exact IR + runtime shape the emitter was built from - compared against the latest to
  // force a rebuild on drift (recompile-while-other-invalid, or a geometry/renderMode/shadow change).
  private builtShader: FXCompiledShader | undefined = undefined;
  private builtKernel: FXCompiledKernel | undefined = undefined;
  private builtGeometryKey: string | undefined = undefined;
  // Only meaningful for `config.geometry.kind === "custom"`: catches a mesh asset that was
  // deleted/re-uploaded under the same authored name, which a built emitter can't pick up live.
  private builtCustomGeometryRef: BufferGeometry | undefined = undefined;
  private builtRenderMode: RenderMode | undefined = undefined;
  // Surface-sink params, invisible to the live gate's IR hash - tracked to force a rebuild on
  // flip (the depth material is attached at build time in installEmitter).
  private builtCastShadow = false;
  private builtReceiveShadow = false;
  // The spawn sink's "Try GPU simulation" flag and expected-particle-count, also invisible to
  // the live gate's IR hash - tracked the same way, since editing either alone must still force
  // a rebuild through installEmitter (a capacity edit resizes the state buffers either backend).
  private builtTryGpuSimulation = false;
  private builtExpectedCapacity = 0;
  // The current apply()'s spawn-sink flag, read by the behavior target-builder closure in the
  // constructor below - FXBehaviorTargets is derived per snapshot, so this must be current
  // before behaviorLive.apply runs each call.
  private currentTryGpuSimulation = false;

  // param names driven by the timeline last frame - so one that drops out reverts to baseline.
  private readonly drivenParams = new Set<string>();
  // The last transform applied, re-asserted onto a freshly (re)built emitter so a structural
  // edit never snaps the pose back to the origin between rebuild and the next drive tick.
  private lastTransform: Transform | undefined = undefined;
  // The last visibility set (the outline's mute toggle), re-asserted the same way so a rebuild
  // never flashes a muted emitter visible again.
  private lastVisible = true;
  // The persistent preview gizmo (wireframe box), re-parented onto each rebuilt emitter Object3D.
  private readonly marker: GizmoMarker = createGizmoMarker("emitter");

  constructor(
    private readonly parent: Object3D,
    private readonly resolveTexture: TextureResolver,
    private readonly camera: Camera,
    // The live renderer - handed to installEmitter's GPU (transform-feedback) driver gate so it
    // can check capabilities.isWebGL2 and construct against the real WebGL2 context.
    private readonly renderer: WebGLRenderer,
    // Node registries are stateless factory maps, so every view shares one pair (owned by
    // SceneEmitters) rather than re-registering the standard node set per emitter.
    renderRegistry: FXNodeRegistry<FXRenderNode>,
    behaviorRegistry: FXNodeRegistry<FXBehaviorNode>,
    // Which GLSL tier this view's live render graph compiles with (settings/renderBackend.ts) -
    // fixed for the session; the preview's own switch reloads the page to change it.
    renderBackend: FXGLSLRenderTier,
    // The content library's live mesh geometries, by name - a "custom" geometry source resolves
    // through this the same way an external texture resolves through `resolveTexture`.
    private readonly resolveMeshGeometries: () => Readonly<
      Record<string, BufferGeometry>
    > = () => ({}),
  ) {
    this.renderLive = new FXLiveGraph(
      new FXGraphReconciler(renderRegistry),
      new FXRenderLiveBackend(
        renderBackend,
        // The target is derived per snapshot from the graph's attributes (lighting-model-independent).
        (attributes) => buildParticleTarget(attributes),
        (compiled) => {
          this.shader = compiled;
          this.renderAttributes = collectAttributeRequests(this.renderLive.graphView).requests;
        },
      ),
    );
    this.behaviorLive = new FXLiveGraph(
      new FXGraphReconciler(behaviorRegistry),
      new FXBehaviorLiveBackend(
        (bundle) => {
          this.kernel = bundle.kernel;
          this.standardProgram = bundle.standardProgram;
          this.behaviorAttributes = collectAttributeRequests(this.behaviorLive.graphView).requests;
        },
        (attributes) => buildParticleBehaviorTargets(attributes, this.currentTryGpuSimulation),
      ),
    );
  }

  /** Currently alive particle count for this emitter (0 before an emitter is built). */
  public get particleCount(): number {
    return this.emitter?.particleCount ?? 0;
  }

  /** The runtime emitter's Object3D (its transform is the emitter's pose), or `undefined` before build. */
  public get object3D(): Object3D | undefined {
    return this.emitter;
  }

  /** Whether the outline's mute toggle currently shows this emitter (survives a rebuild). */
  public get visible(): boolean {
    return this.lastVisible;
  }

  /** The gizmo's invisible pick proxy, raycast to select this emitter in the viewport. */
  public get pickTarget(): Object3D {
    return this.marker.pickTarget;
  }

  public apply(
    renderSnapshot: FXGraphSnapshotData,
    behaviorSnapshot: FXGraphSnapshotData,
    config: RenderSinkConfig,
    spawnConfig: SpawnSinkConfig,
    // The sole source of truth for which attributes exist - checked against every read-attribute
    // request in either graph, so a name left over after a removal/retype is a held error.
    declaredAttributes: readonly EditorAttribute[],
  ): GraphApplyResult {
    // Surface-sink params, invisible to the live gate's IR hash like geometry/renderMode - the
    // structural chain below tracks them to force a rebuild (the depth material is attached on build).
    const { geometry, renderMode, sortInterval, castShadow, receiveShadow } = config;
    // Read by the behaviorLive target-builder closure (constructor) - must be set before
    // behaviorLive.apply runs below, since validate/previewHash/compile all read it synchronously.
    this.currentTryGpuSimulation = spawnConfig.tryGpuSimulation;

    // Each live graph reconciles + gates internally and never throws: a bad edit (unknown node,
    // failed validation, a codegen fault) comes back in its `errors`, holding the last good IR.
    const renderResult = this.renderLive.apply(renderSnapshot);
    const behaviorResult = this.behaviorLive.apply(behaviorSnapshot);

    // The preview is all-or-nothing (the two artifacts run as one emitter). If either graph is
    // invalid, surface its node-attributed errors and leave the last emitter running.
    if (renderResult.status === "invalid" || behaviorResult.status === "invalid") {
      return {
        render:
          renderResult.status === "invalid" ? invalidFromErrors(renderResult.errors) : BLOCKED,
        behavior:
          behaviorResult.status === "invalid" ? invalidFromErrors(behaviorResult.errors) : BLOCKED,
        emitterRebuilt: false,
      };
    }

    // Both graphs are valid, so each live graph has installed its current IR through the backend
    // callback above; guard defensively (a valid apply always installs both before we get here).
    if (this.shader === undefined || this.kernel === undefined) {
      const held = invalid(["EmitterView: no compiled IR after a valid apply"]);
      return { render: held, behavior: held, emitterRebuilt: false };
    }

    // A *cross-graph* attribute conflict (behavior writes `foo` as vec3, render reads vec2) is
    // invisible to each graph's own validation - hold it as `invalid` rather than let the rebuild throw.
    const crossErrors = mergeAttributeCollections(
      { requests: this.renderAttributes, errors: [] },
      { requests: this.behaviorAttributes, errors: [] },
    ).errors;
    const attributeErrors = [
      ...crossErrors,
      ...undeclaredAttributeErrors(
        this.renderAttributes,
        this.behaviorAttributes,
        declaredAttributes,
      ),
    ];
    if (attributeErrors.length > 0) {
      return {
        render: invalidFromErrors(attributeErrors),
        behavior: BLOCKED,
        emitterRebuilt: false,
      };
    }

    // Assembly copies compiled strings + snapshots values (no code generation), so a value-only
    // rebind never re-pays the compile. A same-name binding conflict would throw here; hold rather than crash.
    let artifacts: PreviewArtifacts;
    try {
      artifacts = {
        render: assembleRenderArtifact(
          this.shader,
          collectLightingRequirements(this.renderLive.graphView),
          toArtifactGeometrySource(geometry),
          this.renderAttributes,
          renderMode,
        ),
        behavior: assembleBehaviorArtifact(this.kernel, this.behaviorAttributes),
        ...(this.standardProgram !== undefined
          ? { gpuBehavior: assembleGpuKernelArtifact(this.standardProgram) }
          : {}),
      };
    } catch (error) {
      const held = invalid([describeError(error)]);
      return { render: held, behavior: held, emitterRebuilt: false };
    }
    this.artifacts = artifacts;

    const currentCustomGeometryRef =
      geometry.kind === "custom" ? this.resolveMeshGeometries()[geometry.meshAssetName] : undefined;
    // Everything that reshapes the render half specifically (new GLSL, geometry primitive/mesh,
    // composite mode, shadow flags) - independent of whether the behavior half changed at all, so
    // a render-only edit below can hot-swap in place instead of a full rebuild.
    const renderStructural =
      renderResult.status === "recompiled" ||
      // geometry/renderMode reshape the runtime mesh+material, not the IR - force a rebuild here.
      // Compared by encoded key, not identity: `geometry` is a fresh object every apply.
      encodeGeometrySource(geometry) !== this.builtGeometryKey ||
      // A "custom" reference whose bound mesh asset was deleted or re-uploaded (a new baked object,
      // same name) - the authored param string above is unchanged, so only this catches it.
      currentCustomGeometryRef !== this.builtCustomGeometryRef ||
      renderMode !== this.builtRenderMode ||
      // Shadow flags reshape the runtime mesh (attach/detach the depth material), not the IR.
      castShadow !== this.builtCastShadow ||
      receiveShadow !== this.builtReceiveShadow ||
      // The emitter fell behind during an invalid interlude on the other graph - resync.
      this.shader !== this.builtShader;
    // Everything that reshapes the behavior half specifically (simulation, capacity, CPU/GPU
    // backend choice) - only this half genuinely needs a full FXEmitter.fromArtifacts rebuild,
    // since only a fresh driver can resize particle buffers or swap backend.
    const behaviorStructural =
      behaviorResult.status === "recompiled" ||
      spawnConfig.tryGpuSimulation !== this.builtTryGpuSimulation ||
      spawnConfig.expectedCapacity !== this.builtExpectedCapacity ||
      this.kernel !== this.builtKernel;

    if (this.emitter === undefined || behaviorStructural) {
      return this.rebuildEmitter(artifacts, config, spawnConfig, currentCustomGeometryRef);
    }

    if (renderStructural) {
      try {
        this.emitter.applyRenderArtifact(artifacts.render, {
          textures: this.resolveExternalTextures(artifacts.render),
          geometries: this.resolveMeshGeometries(),
          castShadow,
          receiveShadow,
        });
      } catch (error) {
        // The active driver refused (a genuine attribute-layout change only a fresh driver can
        // safely resize buffers for) - fall back to a full rebuild rather than surfacing this as
        // an error; the editor never asked the user to know which path preserved the particles.
        console.warn(
          "EmitterView: a render-only artifact swap was rejected (attribute layout changed) - " +
            "falling back to a full rebuild.",
          error,
        );
        return this.rebuildEmitter(artifacts, config, spawnConfig, currentCustomGeometryRef);
      }
      this.builtShader = this.shader;
      this.builtGeometryKey = encodeGeometrySource(geometry);
      this.builtCustomGeometryRef = currentCustomGeometryRef;
      this.builtRenderMode = renderMode;
      this.builtCastShadow = castShadow;
      this.builtReceiveShadow = receiveShadow;
      this.applySorting(sortInterval);
      // Particle buffers/instance count/simulation were never touched - no rebuild happened, so
      // playback must not restart over this (see emitterRebuilt on GraphApplyResult).
      return { render: RECOMPILED, behavior: REBOUND, emitterRebuilt: false };
    }

    // Neither half is structural: only values changed. Scrub them into the running emitter so
    // live particles never reset (external textures ride the value path too, so a texture swap
    // rebinds).
    this.emitter.applyValues(this.valuesFromArtifacts(this.artifacts));
    this.applySorting(sortInterval);
    return { render: REBOUND, behavior: REBOUND, emitterRebuilt: false };
  }

  public destroy(): void {
    this.marker.object.removeFromParent();
    this.marker.dispose();
    this.emitter?.destroy();
    this.emitter = undefined;
    this.artifacts = undefined;
    this.drivenParams.clear();
    this.renderLive.destroy();
    this.behaviorLive.destroy();
  }

  /** Highlights this emitter's preview gizmo as the selected one (accent tint), or not. */
  public setSelected(selected: boolean): void {
    this.marker.setSelected(selected);
  }

  /** Scrubs sampled param values into the running emitter; a param dropped since last frame
   * reverts to its baked baseline (deleting a keyframe restores the inline default). */
  public driveParamValues(values: ReadonlyMap<string, number | readonly number[]>): void {
    if (this.emitter === undefined || this.artifacts === undefined) {
      return;
    }
    const artifacts = this.artifacts;
    const uniforms: Record<string, number | readonly number[] | Texture> = {};
    const bindings: Record<string, number | Float32Array> = {};

    for (const [name, value] of values) {
      this.writeParamSlots(artifacts, name, value, uniforms, bindings);
      this.drivenParams.add(name);
    }
    for (const name of [...this.drivenParams]) {
      if (!values.has(name)) {
        this.writeParamBaseline(artifacts, name, uniforms, bindings);
        this.drivenParams.delete(name);
      }
    }
    if (Object.keys(uniforms).length > 0 || Object.keys(bindings).length > 0) {
      this.emitter.applyValues({ uniforms, bindings });
    }
  }

  /** Queues a one-shot burst of `count` particles (fires on the next simulation step). */
  public burst(count: number): void {
    this.emitter?.burst(count);
  }

  /** Starts a continuous emission of `rate` particles/second for `duration` seconds (0 = forever). */
  public play(rate: number, duration: number): void {
    // A 0 duration means an infinite play: omit it so the runtime defaults to Infinity.
    this.emitter?.play(rate, duration > 0 ? { duration } : {});
  }

  /** Clears live particles and cancels any active emission - the emitter returns to idle. */
  public reset(): void {
    this.emitter?.stop();
    this.emitter?.reset();
  }

  /** Shows/hides the emitter in the preview (the outline's mute toggle). Cached like the pose. */
  public setVisible(visible: boolean): void {
    this.lastVisible = visible;
    if (this.emitter !== undefined) {
      this.emitter.visible = visible;
    }
  }

  /** Poses the running emitter's Object3D. Cached so a later rebuild keeps the pose. */
  public applyTransform(transform: Transform): void {
    this.lastTransform = transform;
    if (this.emitter !== undefined) {
      applyTransform(this.emitter, transform);
    }
  }

  /** Full rebuild path: a fresh `FXEmitter.fromArtifacts` replacing the previous one - resets
   *  particle buffers and playback. Used for the first build, any behavior-structural change, or
   *  as the fallback when a render-only swap ({@link applyRenderArtifact}) refuses a genuine
   *  attribute-layout change it cannot apply in place. */
  private rebuildEmitter(
    artifacts: PreviewArtifacts,
    config: RenderSinkConfig,
    spawnConfig: SpawnSinkConfig,
    currentCustomGeometryRef: BufferGeometry | undefined,
  ): GraphApplyResult {
    const { geometry, renderMode, sortInterval, castShadow, receiveShadow } = config;
    try {
      this.installEmitter(
        artifacts,
        castShadow,
        receiveShadow,
        spawnConfig.tryGpuSimulation,
        spawnConfig.expectedCapacity,
      );
    } catch (error) {
      // The runtime rejected the artifact pair; installEmitter builds the new emitter before
      // dropping the old, so the last good preview still runs - hold rather than crash.
      const held = invalid([describeError(error)]);
      return { render: held, behavior: held, emitterRebuilt: false };
    }
    this.builtShader = this.shader;
    this.builtKernel = this.kernel;
    this.builtGeometryKey = encodeGeometrySource(geometry);
    this.builtCustomGeometryRef = currentCustomGeometryRef;
    this.builtRenderMode = renderMode;
    this.builtCastShadow = castShadow;
    this.builtReceiveShadow = receiveShadow;
    this.builtTryGpuSimulation = spawnConfig.tryGpuSimulation;
    this.builtExpectedCapacity = spawnConfig.expectedCapacity;
    this.applySorting(sortInterval);
    return { render: RECOMPILED, behavior: RECOMPILED, emitterRebuilt: true };
  }

  /** Every external sampler slot `artifact` declares, bound to its live texture - shared by
   *  {@link installEmitter} (a full rebuild) and the render-only swap path (`applyRenderArtifact`). */
  private resolveExternalTextures(artifact: FXRenderArtifact): Record<string, Texture> {
    const textures: Record<string, Texture> = {};
    for (const slot of externalSlots(artifact)) {
      textures[paramUniformName(slot.paramName)] = this.resolveTexture(slot.paramName);
    }
    return textures;
  }

  /** Configures camera depth-sorting from `sortInterval` (frames/sort; 0 disables). Applied on
   * every reconcile, so live-editing the field updates in place. */
  private applySorting(sortInterval: number): void {
    if (this.emitter === undefined) {
      return;
    }
    if (sortInterval > 0) {
      this.emitter.sortCamera = this.camera;
      this.emitter.sortFraction = 1 / sortInterval;
    } else {
      // The runtime disables sorting when `sortCamera` is absent; clear it rather than assign
      // `undefined` (rejected under exactOptionalPropertyTypes).
      delete this.emitter.sortCamera;
    }
  }

  /** The live uniform/binding values to scrub into a running emitter on a rebind. */
  private valuesFromArtifacts(artifacts: PreviewArtifacts): FXApplyValues {
    const uniforms: Record<string, number | readonly number[] | Texture> = {};
    for (const [name, init] of Object.entries(artifacts.render.uniforms)) {
      if (init.value !== undefined) {
        uniforms[name] = init.value;
      }
    }
    // External sampler slots carry no baked value: bind each to its live texture.
    for (const slot of externalSlots(artifacts.render)) {
      uniforms[slot.uniformName] = this.resolveTexture(slot.paramName);
    }
    const bindings: Record<string, number | Float32Array> = {};
    for (const [name, slot] of Object.entries(artifacts.behavior.bindings)) {
      bindings[name] = slot.value;
    }
    return { uniforms, bindings };
  }

  /** Writes one param's value into whichever render uniform / behavior bindings it declares. */
  private writeParamSlots(
    artifacts: PreviewArtifacts,
    name: string,
    value: number | readonly number[],
    uniforms: Record<string, number | readonly number[] | Texture>,
    bindings: Record<string, number | Float32Array>,
  ): void {
    const uniformKey = paramUniformName(name);
    if (uniformKey in artifacts.render.uniforms) {
      uniforms[uniformKey] = value;
    }
    // Behavior scalarizes a vector into one binding per component (`b_param_<name>_x/...`);
    // a scalar param is the single `b_param_<name>`.
    const bindingKey = paramBindingName(name);
    if (bindingKey in artifacts.behavior.bindings) {
      bindings[bindingKey] = typeof value === "number" ? value : (value[0] ?? 0);
      return;
    }
    const vector = typeof value === "number" ? [value] : value;
    PARAM_COMPONENTS.forEach((component, index) => {
      const key = `${bindingKey}_${component}`;
      if (key in artifacts.behavior.bindings) {
        bindings[key] = vector[index] ?? 0;
      }
    });
  }

  /** Restores one param's baked baseline into its declared slots (a param that stopped driving). */
  private writeParamBaseline(
    artifacts: PreviewArtifacts,
    name: string,
    uniforms: Record<string, number | readonly number[] | Texture>,
    bindings: Record<string, number | Float32Array>,
  ): void {
    const uniformKey = paramUniformName(name);
    const uniform = artifacts.render.uniforms[uniformKey];
    if (uniform !== undefined && "value" in uniform) {
      uniforms[uniformKey] = uniform.value;
    }
    for (const [key, slot] of Object.entries(artifacts.behavior.bindings)) {
      if (key === paramBindingName(name) || key.startsWith(`${paramBindingName(name)}_`)) {
        bindings[key] = slot.value;
      }
    }
  }

  /** Replaces the running emitter with a fresh one for the new artifacts. May throw (see caller). */
  private installEmitter(
    artifacts: PreviewArtifacts,
    castShadow: boolean,
    receiveShadow: boolean,
    tryGpuSimulation: boolean,
    expectedCapacity: number,
  ): void {
    // Every external sampler slot must be bound at build time (a missing one throws); a
    // deleted/absent texture resolves to a transparent fallback, keeping the preview alive.
    const textures = this.resolveExternalTextures(artifacts.render);
    // Present only when actually compiled: `gpuKernel` is a bare optional under
    // exactOptionalPropertyTypes, so an explicit `undefined` value is rejected - omit the key.
    // isWebGL2 gates USE here only, never whether to compile (already compiled/cached above
    // regardless, so exportCompile.ts - which has no live renderer to gate on - stays consistent).
    const gpuKernel =
      tryGpuSimulation && this.renderer.capabilities.isWebGL2 ? artifacts.gpuBehavior : undefined;
    // Build the new emitter BEFORE dropping the old one: fromArtifacts can throw on a bad artifact
    // pair, and the caller holds the last good preview on a throw - so the old emitter must survive.
    const next = FXEmitter.fromArtifacts(artifacts.render, artifacts.behavior, {
      textures,
      geometries: this.resolveMeshGeometries(),
      castShadow,
      receiveShadow,
      renderer: this.renderer,
      expectedCapacity,
      ...(gpuKernel !== undefined ? { gpuKernel } : {}),
    });
    this.emitter?.destroy();
    this.emitter = next;
    this.parent.add(next);
    // The preview gizmo rides the emitter's Object3D, so re-parent it onto the fresh emitter.
    next.add(this.marker.object);
    // Re-assert the last pose + visibility onto the new Object3D (fromArtifacts starts visible, at
    // the origin).
    if (this.lastTransform !== undefined) {
      applyTransform(next, this.lastTransform);
    }
    next.visible = this.lastVisible;
    // No automatic emission: spawning is driven by the timeline's burst/play events, not by
    // the emitter's mere existence. A fresh emitter starts idle until an event fires.
  }
}

/** Writes a {@link Transform} onto a Three Object3D (rotation renormalized for safety). */
export function applyTransform(object: Object3D, transform: Transform): void {
  object.position.set(transform.position[0], transform.position[1], transform.position[2]);
  const quaternion = normalizeQuat(transform.rotation);
  object.quaternion.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
  object.scale.set(transform.scale[0], transform.scale[1], transform.scale[2]);
}
