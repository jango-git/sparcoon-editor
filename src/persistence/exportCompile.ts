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
import type { FXCompilerError } from "../engine/core/compiler/FXCompilerError";
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
  buildTrailTarget,
  FX_MESH_TARGET,
} from "../engine/render/target/FXParticleRenderTarget";
import { collectAttributeRequests } from "../engine/core/compiler/collectAttributeRequests";
import {
  collectRenderCapabilities,
  type FXRenderCapabilities,
} from "../engine/core/compiler/collectRenderCapabilities";
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
import type { FXBufferLayout, FXGeometrySource } from "sparcoon";
import { fxMeshRenderBudget } from "sparcoon/editor";
import { assembleRenderArtifact, attributeDecls } from "../engine/emit/assembleArtifacts";
import { kernelWrittenBuffers, unwrittenAttributeWarnings } from "../domain/attributeChecks";
import {
  emitterRenderBudgetFindings,
  renderBudgetFindings,
  trailRenderBudgetFindings,
  type RenderBudgetFindings,
} from "../domain/renderBudget";
import { gpuSortWarnings } from "../domain/sortChecks";
import { TRAIL_GEOMETRY, trailAttributeErrors, trailSortError } from "../domain/trailChecks";
import { depthFadeModeErrors } from "../domain/depthFadeChecks";
import type { EditorGraph } from "../domain/graphModel";
import {
  GraphKind,
  readRenderSinkConfig,
  readSpawnSinkConfig,
  readTrailSinkConfig,
  timelineValueConflicts,
  toArtifactGeometrySource,
  type RenderMode,
  type SpawnSinkConfig,
} from "../domain/nodePalette";
import { serializeGraph, undeclaredAttributeErrors } from "../domain/serialize";
import { emitterGraphs, type EmitterDoc, type VfxMeshDoc } from "../model/editorState";

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
  readonly capabilities: FXRenderCapabilities;
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
  /** The emitter's trail; absent when it has none. */
  readonly trail?: TrailIR;
  /**
   * What the export ships but the author may not mean - the live preview shows the same ones on
   * the render graph (domain/attributeChecks.ts). Never stops an export.
   */
  readonly warnings: readonly FXCompilerError[];
}

/** An emitter's trail graph, compiled through every GLSL tier like its render graph. */
export interface TrailIR {
  readonly shaders: CompiledShadersByGLSLTier;
  readonly capabilities: FXRenderCapabilities;
  readonly renderAttributes: readonly FXAttributeRequest[];
  readonly renderMode: RenderMode;
  readonly frames: number;
  readonly sampleInterval: number;
  /** The same as {@link EmitterIR.warnings}, for the trail graph. */
  readonly warnings: readonly FXCompilerError[];
}

/**
 * Compiles an emitter's trail graph, held to the same checks as the live preview
 * (domain/trailChecks.ts) and the same GPU budget (domain/renderBudget.ts) - counting the GPU
 * backend's history over `kernelBuffers`, the slot of the GPU kernel the emitter ships, if any.
 */
function compileTrail(
  emitter: EmitterDoc,
  trailGraph: EditorGraph,
  sortInterval: number,
  behaviorAttributes: readonly FXAttributeRequest[],
  kernel: FXCompiledKernel,
  kernelBuffers: readonly FXBufferLayout[] | undefined,
): TrailIR {
  const fail = (message: string): never => {
    throw new Error(`exportTypeScript: ${emitter.name} (trail): ${message}`);
  };
  const sortError = trailSortError(sortInterval);
  if (sortError !== undefined) {
    fail(sortError.message);
  }
  const graph = buildRenderGraph(trailGraph);
  const config = readTrailSinkConfig(trailGraph);
  const renderAttributes = collectAttributeRequests(graph).requests;
  const [attributeError] = trailAttributeErrors(
    renderAttributes,
    behaviorAttributes,
    emitter.behaviorGraph.attributes,
  );
  if (attributeError !== undefined) {
    fail(attributeError.message);
  }
  const [depthFadeError] = depthFadeModeErrors(graph, config.renderMode);
  if (depthFadeError !== undefined) {
    fail(depthFadeError.message);
  }
  const shaders = compileForEveryGLSLTier(graph, buildTrailTarget(renderAttributes));
  const capabilities = collectRenderCapabilities(graph);
  const [budgetError] = trailRenderBudgetFindings(
    assembleRenderArtifact(
      shaders.standard,
      capabilities,
      TRAIL_GEOMETRY,
      renderAttributes,
      config.renderMode,
    ),
    attributeDecls(behaviorAttributes),
    kernelBuffers,
  ).errors;
  if (budgetError !== undefined) {
    fail(budgetError.message);
  }
  return {
    shaders,
    capabilities,
    renderAttributes,
    renderMode: config.renderMode,
    frames: config.frames,
    sampleInterval: config.sampleInterval,
    warnings: unwrittenAttributeWarnings(
      graph,
      kernelWrittenBuffers(kernel),
      emitter.behaviorGraph.attributes,
    ),
  };
}

/**
 * Compiles one emitter for the export. `spawnConfig` is how it runs - the export passes
 * `effectiveSpawnConfig` (a death source is never offered the GPU); defaults to what its spawn node
 * asks for, for an emitter compiled on its own.
 */
export function compileEmitter(
  emitter: EmitterDoc,
  spawnConfig: SpawnSinkConfig = readSpawnSinkConfig(emitter.behaviorGraph),
): EmitterIR {
  // A Timeline Value declared at two types or with two defaults across the emitter's graphs.
  const [declarationConflict] = timelineValueConflicts(emitterGraphs(emitter));
  if (declarationConflict !== undefined) {
    throw new Error(`exportTypeScript: ${emitter.name}: ${declarationConflict.error.message}`);
  }
  const renderGraph = buildRenderGraph(emitter.renderGraph);
  const behaviorGraph = buildBehaviorGraph(emitter.behaviorGraph);
  const config = readRenderSinkConfig(emitter.renderGraph);

  const renderAttributes = collectAttributeRequests(renderGraph).requests;
  const behaviorAttributes = collectAttributeRequests(behaviorGraph).requests;
  // A custom-attribute/custom-attribute-split node left over after its declaration
  // was removed or retyped elsewhere in the graph compiles fine on its own (each graph's own
  // collect is blind to the declared list) - refuse to ship it rather than export a
  // silently-stale buffer read.
  const staleAttributeErrors = undeclaredAttributeErrors(
    renderAttributes,
    behaviorAttributes,
    emitter.behaviorGraph.attributes,
  );
  const firstStaleAttributeError = staleAttributeErrors[0];
  if (firstStaleAttributeError !== undefined) {
    throw new Error(`exportTypeScript: ${emitter.name}: ${firstStaleAttributeError.message}`);
  }

  const [depthFadeError] = depthFadeModeErrors(renderGraph, config.renderMode);
  if (depthFadeError !== undefined) {
    throw new Error(`exportTypeScript: ${emitter.name}: ${depthFadeError.message}`);
  }
  const shaders = compileForEveryGLSLTier(renderGraph, buildParticleTarget(renderAttributes));
  const capabilities = collectRenderCapabilities(renderGraph);

  // Compiled before the budget is counted: the GPU kernel's slot layout, when there is one,
  // decides what the Standard tier's particle mesh takes.
  const bundle = compileBehaviorBundle(
    behaviorGraph,
    buildParticleBehaviorTargets(behaviorAttributes, spawnConfig.tryGpuSimulation),
  );
  const kernelBuffers = bundle.standardProgram?.buffers;
  requireWithinRenderBudget(
    emitter.name,
    emitterRenderBudgetFindings(
      assembleRenderArtifact(
        shaders.standard,
        capabilities,
        toArtifactGeometrySource(config.geometry),
        renderAttributes,
        config.renderMode,
      ),
      attributeDecls(behaviorAttributes),
      config.castShadow,
      kernelBuffers,
    ),
  );

  return {
    shaders,
    capabilities,
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
    warnings: [
      ...unwrittenAttributeWarnings(
        renderGraph,
        kernelWrittenBuffers(bundle.kernel),
        emitter.behaviorGraph.attributes,
      ),
      // A WebGL2 host runs the shipped GPU kernel, and ignores the sort there.
      ...gpuSortWarnings(config.sortInterval, bundle.standardProgram !== undefined),
    ],
    ...(emitter.trailGraph === undefined
      ? {}
      : {
          trail: compileTrail(
            emitter,
            emitter.trailGraph,
            config.sortInterval,
            behaviorAttributes,
            bundle.kernel,
            kernelBuffers,
          ),
        }),
  };
}

export interface MeshIR {
  readonly shaders: CompiledShadersByGLSLTier;
  readonly capabilities: FXRenderCapabilities;
  readonly geometry: FXGeometrySource;
  readonly renderMode: "blending" | "alphaHash" | "alphaTest" | "opaque";
  readonly castShadow: boolean;
  readonly receiveShadow: boolean;
}

export function compileMesh(mesh: VfxMeshDoc): MeshIR {
  const renderGraph = buildRenderGraph(mesh.renderGraph);
  const config = readRenderSinkConfig(mesh.renderGraph);
  const [depthFadeError] = depthFadeModeErrors(renderGraph, config.renderMode);
  if (depthFadeError !== undefined) {
    throw new Error(`exportTypeScript: ${mesh.name}: ${depthFadeError.message}`);
  }
  const shaders = compileForEveryGLSLTier(renderGraph, FX_MESH_TARGET);
  const capabilities = collectRenderCapabilities(renderGraph);
  requireWithinRenderBudget(
    mesh.name,
    renderBudgetFindings(
      fxMeshRenderBudget(
        assembleRenderArtifact(
          shaders.standard,
          capabilities,
          toArtifactGeometrySource(config.geometry),
          [],
          config.renderMode,
        ),
        { castShadow: config.castShadow },
      ),
    ),
  );
  return {
    shaders,
    capabilities,
    geometry: toArtifactGeometrySource(config.geometry),
    renderMode: config.renderMode,
    castShadow: config.castShadow,
    receiveShadow: config.receiveShadow,
  };
}

/**
 * Refuses an emitter or mesh whose Standard-tier materials some WebGL2 GPU could not link (see
 * domain/renderBudget.ts) - the live preview holds the same graph as invalid.
 */
function requireWithinRenderBudget(name: string, findings: RenderBudgetFindings): void {
  const [error] = findings.errors;
  if (error !== undefined) {
    throw new Error(`exportTypeScript: ${name}: ${error.message}`);
  }
}

/**
 * The lighting intrinsics a render graph's reachable nodes need - empty means the surface is
 * unlit, as it is unless a lighting node feeds it. `undefined` when the graph does not reconcile
 * (it would not compile either). The same reading the export makes, without compiling shaders.
 */
export function renderGraphLighting(editorGraph: EditorGraph): readonly string[] | undefined {
  try {
    return collectRenderCapabilities(buildRenderGraph(editorGraph)).lightingIntrinsics;
  } catch {
    return undefined;
  }
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
