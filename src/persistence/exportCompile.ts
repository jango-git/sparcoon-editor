/**
 * Headless graph compilation for the TypeScript export: reconciles an editor graph into a real
 * engine `FXGraph`, then compiles its render graph through every registered GLSL-family render
 * compiler (`FX_GLSL_RENDER_COMPILERS` - today `baseline`/`standard`) and its behavior graph
 * through the same `compileBehaviorBundle` the live preview uses. Kernel output matches what the
 * editor showed; the render side ships both tiers (the live preview only ever compiles the
 * baseline one).
 */

import type { FXRenderNode } from "../engine/render/FXRenderNode";
import type { FXBehaviorNode } from "../engine/behavior/FXBehaviorNode";
import type { FXAttributeRequest } from "../engine/core/socket/FXAttribute";
import type { FXCompiledShader } from "../engine/render/compiler/FXCompiledShader";
import type { FXCompiledKernel } from "../engine/behavior/FXCompiledKernel";
import type { FXGraphSnapshotData } from "../engine/core/live/FXSnapshotData";
import { FXGraph } from "../engine/core/FXGraph";
import { FXGraphReconciler } from "../engine/core/live/FXGraphReconciler";
import { FXNodeRegistry } from "../engine/core/live/FXNodeRegistry";
import {
  registerStandardBehaviorNodes,
  registerStandardRenderNodes,
} from "../engine/nodes-std/index";
import { registerManualRenderNodes } from "../engine/render/nodes/FXManualRenderNodes";
import { registerManualBehaviorNodes } from "../engine/behavior/nodes/FXManualBehaviorNodes";
import type { FXTarget } from "../engine/render/target/FXTarget";
import { FX_GLSL_RENDER_COMPILERS } from "../engine/render/compiler/FXRenderCompilers";
import {
  buildParticleTarget,
  FX_MESH_TARGET,
} from "../engine/render/target/FXParticleRenderTarget";
import { collectAttributeRequests } from "../engine/core/compiler/collectAttributeRequests";
import { collectLightingRequirements } from "../engine/core/compiler/collectLightingRequirements";
import { buildParticleBehaviorTargets } from "../engine/behavior/FXParticleBehaviorTarget";
import { compileBehaviorBundle } from "../engine/behavior/FXCompiledBehaviorBundle";
import type { FXFusedProgramStandard } from "../engine/behavior/FXKernelBuildStandard.Internal";
import { paramUniformName } from "../engine/nodes-std/paramSupport.Internal";
import {
  FX_FBM3_JS_HELPER,
  FX_FBM_JS_HELPER,
  FX_FRACT_HELPER,
  FX_MIX_HELPER,
  FX_MOD_HELPER,
  FX_NOISE_JS_HELPER,
  FX_SMOOTHSTEP_HELPER,
} from "../engine/core/ir/FXFunctions.Internal";
import { SAMPLE_LUT_HELPER_SOURCE } from "../engine/behavior/nodes/FXBehaviorNodeShared.Internal";
import type { FXGeometrySource } from "sparcoon";
import type { EditorGraph } from "../domain/graphModel";
import {
  GraphKind,
  readRenderSinkConfig,
  readSpawnSinkConfig,
  toArtifactGeometrySource,
} from "../domain/nodePalette";
import { serializeGraph, undeclaredAttributeErrors } from "../domain/serialize";
import type { EmitterDoc, VfxMeshDoc } from "../model/editorState";

/**
 * Compiled helper source (matched by identity) -> the `sparcoon` export name(s) it corresponds to.
 * A helper missing here fails loudly (see {@link helperImportNames}) instead of silently omitting
 * an import.
 */
const HELPER_IMPORT_NAMES: ReadonlyMap<string, readonly string[]> = new Map([
  [FX_FRACT_HELPER, ["fxFract"]],
  [FX_MOD_HELPER, ["fxMod"]],
  [FX_MIX_HELPER, ["fxMix"]],
  [FX_SMOOTHSTEP_HELPER, ["fxSmoothstep"]],
  [FX_NOISE_JS_HELPER, ["fxNoise1", "fxNoise2", "fxNoise3"]],
  [SAMPLE_LUT_HELPER_SOURCE, ["fxSampleLut"]],
  // fxFbm's editor-side helper is self-contained (own private fxFbmHash1/fxFbmNoise1, not sharing
  // fxNoise1's) but numerically identical to sparcoon's fxFbm - only the exported name matters here.
  [FX_FBM_JS_HELPER, ["fxFbm"]],
  // Same self-contained-but-numerically-identical relationship as fxFbm, for its 3D-domain twin.
  [FX_FBM3_JS_HELPER, ["fxFbm3"]],
]);

export function helperImportNames(source: string): readonly string[] {
  const names = HELPER_IMPORT_NAMES.get(source);
  if (names === undefined) {
    throw new Error(
      "exportTypeScript: a compiled kernel emitted a behavior helper with no matching sparcoon " +
        "export. Add the function to sparcoon's miscellaneous/fxMath.ts and register it in " +
        `HELPER_IMPORT_NAMES:\n${source}`,
    );
  }
  return names;
}

const PARAM_SLOT_PREFIX = paramUniformName("");

// One shared registry pair - the standard node factories are stateless, so a single set serves
// every entity's reconcile.
const renderRegistry = createRenderRegistry();
const behaviorRegistry = createBehaviorRegistry();

/** A render graph compiled through every registered {@link FX_GLSL_RENDER_COMPILERS} backend, by
 *  tier - the export's `render: { baseline, standard }` artifact map mirrors this 1:1. Scoped to
 *  the GLSL family; a future non-GLSL family (the advanced tier) would get its own sibling type,
 *  not a third key here. */
export type CompiledShadersByGLSLTier = Readonly<
  Record<keyof typeof FX_GLSL_RENDER_COMPILERS, FXCompiledShader>
>;

function compileForEveryGLSLTier(
  renderGraph: FXGraph<FXRenderNode>,
  target: FXTarget,
): CompiledShadersByGLSLTier {
  const entries = Object.entries(FX_GLSL_RENDER_COMPILERS).map(
    ([id, compiler]) => [id, compiler.compile(renderGraph, target)] as const,
  );
  return Object.fromEntries(entries) as CompiledShadersByGLSLTier;
}

export interface EmitterIR {
  readonly shaders: CompiledShadersByGLSLTier;
  readonly lightingIntrinsics: readonly string[];
  readonly renderAttributes: readonly FXAttributeRequest[];
  readonly kernel: FXCompiledKernel;
  readonly behaviorAttributes: readonly FXAttributeRequest[];
  /**
   * The "standard" (GLSL/transform-feedback) family's fused program - present only when the spawn
   * sink's "Try GPU simulation" flag is on and the graph compiled to that family. `kernel` above
   * always compiles regardless (the mandatory JS fallback), so a skipped attempt never blocks
   * export - it just omits this field for this one emitter.
   */
  readonly gpuProgram?: FXFusedProgramStandard | undefined;
  readonly geometry: FXGeometrySource;
  readonly renderMode: "blending" | "alphaHash" | "alphaTest" | "opaque";
  readonly sortInterval: number;
  readonly castShadow: boolean;
  readonly receiveShadow: boolean;
  // From the spawn sink (readSpawnSinkConfig), not the surface sink - the same authored number
  // the live preview builds with, so an exported project's capacity never drifts from the editor's.
  readonly expectedCapacity: number;
}

export function compileEmitter(emitter: EmitterDoc): EmitterIR {
  const renderGraph = buildRenderGraph(emitter.renderGraph);
  const behaviorGraph = buildBehaviorGraph(emitter.behaviorGraph);
  const config = readRenderSinkConfig(emitter.renderGraph);
  const spawnConfig = readSpawnSinkConfig(emitter.behaviorGraph);

  const renderAttributes = collectAttributeRequests(renderGraph).requests;
  const behaviorAttributes = collectAttributeRequests(behaviorGraph).requests;
  // A read-attribute/read-attribute-components node left over after its declaration was removed
  // or retyped elsewhere in the graph compiles fine on its own (each graph's own collect is blind
  // to the declared list) - refuse to ship it rather than export a silently-stale buffer read.
  const staleAttributeErrors = undeclaredAttributeErrors(
    renderAttributes,
    behaviorAttributes,
    emitter.behaviorGraph.attributes,
  );
  const firstStaleAttributeError = staleAttributeErrors[0];
  if (firstStaleAttributeError !== undefined) {
    throw new Error(`exportTypeScript: ${emitter.name}: ${firstStaleAttributeError.message}`);
  }

  const shaders = compileForEveryGLSLTier(renderGraph, buildParticleTarget(renderAttributes));
  const lightingIntrinsics = collectLightingRequirements(renderGraph);

  const bundle = compileBehaviorBundle(
    behaviorGraph,
    buildParticleBehaviorTargets(behaviorAttributes, spawnConfig.tryGpuSimulation),
  );

  return {
    shaders,
    lightingIntrinsics,
    renderAttributes,
    kernel: bundle.kernel,
    behaviorAttributes,
    gpuProgram: bundle.standardProgram,
    geometry: toArtifactGeometrySource(config.geometry),
    renderMode: config.renderMode,
    sortInterval: config.sortInterval,
    castShadow: config.castShadow,
    receiveShadow: config.receiveShadow,
    expectedCapacity: spawnConfig.expectedCapacity,
  };
}

export interface MeshIR {
  readonly shaders: CompiledShadersByGLSLTier;
  readonly lightingIntrinsics: readonly string[];
  readonly geometry: FXGeometrySource;
  readonly renderMode: "blending" | "alphaHash" | "alphaTest" | "opaque";
  readonly castShadow: boolean;
  readonly receiveShadow: boolean;
}

export function compileMesh(mesh: VfxMeshDoc): MeshIR {
  const renderGraph = buildRenderGraph(mesh.renderGraph);
  const config = readRenderSinkConfig(mesh.renderGraph);
  const shaders = compileForEveryGLSLTier(renderGraph, FX_MESH_TARGET);
  const lightingIntrinsics = collectLightingRequirements(renderGraph);
  return {
    shaders,
    lightingIntrinsics,
    geometry: toArtifactGeometrySource(config.geometry),
    renderMode: config.renderMode,
    castShadow: config.castShadow,
    receiveShadow: config.receiveShadow,
  };
}

function buildRenderGraph(editorGraph: EditorGraph): FXGraph<FXRenderNode> {
  return reconcile(
    new FXGraphReconciler(renderRegistry),
    serializeGraph(editorGraph, GraphKind.Render),
  );
}

function buildBehaviorGraph(editorGraph: EditorGraph): FXGraph<FXBehaviorNode> {
  return reconcile(
    new FXGraphReconciler(behaviorRegistry),
    serializeGraph(editorGraph, GraphKind.Behavior),
  );
}

function reconcile<N extends FXRenderNode | FXBehaviorNode>(
  reconciler: FXGraphReconciler<N>,
  snapshot: FXGraphSnapshotData,
): FXGraph<N> {
  const graph = new FXGraph<N>();
  const result = reconciler.reconcile(graph, snapshot);
  const firstReconcileError = result.errors[0];
  if (firstReconcileError !== undefined) {
    throw new Error(`exportTypeScript: graph failed to reconcile: ${firstReconcileError.message}`);
  }
  return graph;
}

function createRenderRegistry(): FXNodeRegistry<FXRenderNode> {
  const registry = new FXNodeRegistry<FXRenderNode>();
  registerStandardRenderNodes(registry);
  registerManualRenderNodes(registry);
  return registry;
}

function createBehaviorRegistry(): FXNodeRegistry<FXBehaviorNode> {
  const registry = new FXNodeRegistry<FXBehaviorNode>();
  registerStandardBehaviorNodes(registry);
  registerManualBehaviorNodes(registry);
  return registry;
}

/** The parameter names of a shader's external sampler slots (`u_param_<name>` -> `<name>`). */
export function externalParamNames(shader: FXCompiledShader): string[] {
  const names: string[] = [];
  for (const handle of Object.values(shader.uniforms)) {
    if (handle.external !== undefined) {
      names.push(handle.external.slice(PARAM_SLOT_PREFIX.length));
    }
  }
  return names;
}
