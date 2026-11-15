/**
 * Headless graph compilation for the TypeScript export: reconciles an editor graph into a real
 * engine `FXGraph`, then compiles its render graph through every registered GLSL-family render
 * compiler (`FX_GLSL_RENDER_COMPILERS` - today `baseline`/`standard`) and its behavior graph
 * through the same `compileBehaviorBundle` the live preview uses. Kernel output matches what the
 * editor showed; the render side ships both tiers (the live preview only ever compiles the
 * baseline one).
 */

import type { FXBufferLayout, FXGeometrySource, FXRenderMode } from "sparcoon";

import type { LibraryAssetNames } from "../domain/assetChecks";
import { missingAssetErrors, NO_LIBRARY_ASSETS } from "../domain/assetChecks";
import { kernelWrittenBuffers, unwrittenAttributeWarnings } from "../domain/attributeChecks";
import type { EditorGraph } from "../domain/graphModel";
import { lifetimeUpperBound, unboundedLifetimeWarnings } from "../domain/lifetimeBound";
import {
  GraphKind,
  readRenderSinkConfig,
  readSpawnSinkConfig,
  readStripSinkConfig,
  type RenderMode,
  type SpawnSinkConfig,
  type StripRuntimeFields,
  stripRuntimeFields,
  timelineValueConflicts,
  toArtifactGeometrySource,
} from "../domain/nodePalette";
import {
  emitterRenderBudgetFindings,
  type FXRenderArtifactsByTier,
  meshRenderBudgetFindings,
  type RenderBudgetFindings,
  stripRenderBudgetFindings,
} from "../domain/renderBudget";
import { cpuSceneDepthWarnings, depthFadeModeErrors } from "../domain/sceneDepthChecks";
import { serializeGraph, undeclaredAttributeErrors } from "../domain/serialize";
import {
  emitterDrawsNothingWarnings,
  hiddenParticlesSortError,
  STRIP_GEOMETRY,
  stripAttributeErrors,
  stripSortError,
  stripSpawnWarnings,
} from "../domain/stripChecks";
import type { FXBehaviorNode } from "../engine/behavior/FXBehaviorNode";
import { compileBehaviorBundle } from "../engine/behavior/FXCompiledBehaviorBundle";
import type { FXCompiledKernel } from "../engine/behavior/FXCompiledKernel";
import type { FXFusedProgramStandard } from "../engine/behavior/FXKernelBuildStandard.Internal";
import { kernelResources } from "../engine/behavior/FXKernelShared.Internal";
import { particleBehaviorTargetsFor } from "../engine/behavior/FXParticleBehaviorTarget";
import { SAMPLE_LUT_HELPER_SOURCE } from "../engine/behavior/nodes/FXBehaviorNodeShared.Internal";
import { registerManualBehaviorNodes } from "../engine/behavior/nodes/FXManualBehaviorNodes";
import { collectAttributeRequests } from "../engine/core/compiler/collectAttributeRequests";
import { collectRenderCapabilities } from "../engine/core/compiler/collectRenderCapabilities";
import type { FXCompilerError } from "../engine/core/compiler/FXCompilerError";
import { FXGraph } from "../engine/core/FXGraph";
import {
  FX_FRACT_HELPER,
  FX_MIX_HELPER,
  FX_MOD_HELPER,
  FX_SMOOTHSTEP_HELPER,
  FX_VOLUME_FETCH_HELPER,
} from "../engine/core/ir/FXFunctions.Internal";
import { FX_JS_CURL } from "../engine/core/ir/noise/FXCurlNoise.Internal";
import { FX_JS_FBM } from "../engine/core/ir/noise/FXFractalNoise.Internal";
import { FX_JS_NOISE_HASH } from "../engine/core/ir/noise/FXNoiseHash.Internal";
import { FX_JS_SEED_HASH } from "../engine/core/ir/noise/FXSeedHash.Internal";
import { FX_JS_NOISE, FX_JS_NOISED } from "../engine/core/ir/noise/FXValueNoise.Internal";
import { FX_JS_VORONOI } from "../engine/core/ir/noise/FXVoronoiNoise.Internal";
import { FXGraphReconciler } from "../engine/core/live/FXGraphReconciler";
import { FXNodeRegistry } from "../engine/core/live/FXNodeRegistry";
import type { FXGraphSnapshotData } from "../engine/core/live/FXSnapshotData";
import type { FXAssetKind } from "../engine/core/nodes/FXAssetKind";
import type { FXAttributeRequest } from "../engine/core/socket/FXAttribute";
import { assembleRenderArtifact } from "../engine/emit/assembleArtifacts";
import {
  registerStandardBehaviorNodes,
  registerStandardRenderNodes,
} from "../engine/nodes-std/index";
import { paramUniformName } from "../engine/nodes-std/paramSupport.Internal";
import type { FXCompiledShader } from "../engine/render/compiler/FXCompiledShader";
import { FX_GLSL_RENDER_COMPILERS } from "../engine/render/compiler/FXRenderCompilers";
import type { FXRenderNode } from "../engine/render/FXRenderNode";
import { registerManualRenderNodes } from "../engine/render/nodes/FXManualRenderNodes";
import {
  buildParticleTarget,
  buildStripTarget,
  FX_MESH_TARGET,
} from "../engine/render/target/FXParticleRenderTarget";
import type { FXTarget } from "../engine/render/target/FXTarget";
import { type EmitterDoc, emitterGraphs, type VfxMeshDoc } from "../model/editorState";
import { stripGraphs, type StripName } from "../model/graphSlots";

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
  [SAMPLE_LUT_HELPER_SOURCE, ["fxSampleLut"]],
  [FX_VOLUME_FETCH_HELPER, ["fxVolumeFetch"]],
  // Noise dependencies the kernel body never calls directly: sparcoon keeps them module-private.
  [FX_JS_NOISE_HASH.source, []],
  [FX_JS_NOISED.source, []],
  [FX_JS_NOISE.source, ["fxNoise1", "fxNoise2", "fxNoise3"]],
  [FX_JS_FBM.source, ["fxFractal1", "fxFractal2", "fxFractal3"]],
  [FX_JS_CURL.source, ["fxCurl2", "fxCurl3"]],
  [FX_JS_VORONOI.source, ["fxVoronoi2", "fxVoronoi3"]],
  [FX_JS_SEED_HASH.source, ["fxSeedHash1", "fxSeedHash2", "fxSeedHash3", "fxSeedHash4"]],
]);

export function helperImportNames(source: string): readonly string[] {
  const names = HELPER_IMPORT_NAMES.get(source);
  if (names === undefined) {
    throw new Error(
      "exportTypeScript: a compiled kernel emitted a behavior helper with no matching sparcoon " +
        "export. Add the function to sparcoon (math in miscellaneous/fxMath.ts, noise in " +
        "miscellaneous/noise/), export it from its index and register it in " +
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

/** `shaders` assembled into the render artifact each tier runs - what its budget is counted on. */
function assembleForEveryGLSLTier(
  shaders: CompiledShadersByGLSLTier,
  geometry: FXGeometrySource,
  attributes: readonly FXAttributeRequest[],
  renderMode: FXRenderMode,
): FXRenderArtifactsByTier {
  return {
    baseline: assembleRenderArtifact(shaders.baseline, geometry, attributes, renderMode),
    standard: assembleRenderArtifact(shaders.standard, geometry, attributes, renderMode),
  };
}

export interface EmitterIR {
  readonly shaders: CompiledShadersByGLSLTier;
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
  /** The assets the behavior samples, by kind - what the app supplies by these names. */
  readonly sampledAssets: Readonly<Record<FXAssetKind, readonly string[]>>;
  readonly renderMode: "blending" | "alphaHash" | "alphaTest" | "opaque";
  readonly sortInterval: number;
  readonly castShadow: boolean;
  readonly receiveShadow: boolean;
  /** Whether the particles are drawn (the render sink's Draw Particles): without, the render graph
   *  is still compiled and checked, but not shipped. */
  readonly drawParticles: boolean;
  // From the spawn sink (readSpawnSinkConfig), not the surface sink - the same authored number
  // the live preview builds with, so an exported project's capacity never drifts from the editor's.
  readonly expectedCapacity: number;
  /** The longest lifetime a particle is born with (domain/lifetimeBound.ts); absent when the graph
   *  does not tell. */
  readonly maxLifetime?: number;
  /** The emitter's trail; absent when it has none. */
  readonly trail?: StripIR<"trail">;
  /** The emitter's ribbon; absent when it has none. */
  readonly ribbon?: StripIR<"ribbon">;
  /**
   * What the export ships but the author may not mean - the live preview shows the same ones on
   * the render graph (domain/attributeChecks.ts). Never stops an export.
   */
  readonly warnings: readonly FXCompilerError[];
}

/** An emitter's strip graph, compiled through every GLSL tier like its render graph. */
export interface StripIR<K extends StripName = StripName> {
  readonly shaders: CompiledShadersByGLSLTier;
  readonly renderAttributes: readonly FXAttributeRequest[];
  readonly renderMode: RenderMode;
  /** What the strip's runtime options take from its sink, besides the render artifact. */
  readonly fields: StripRuntimeFields[K];
  /** The same as {@link EmitterIR.warnings}, for the strip's graph. */
  readonly warnings: readonly FXCompilerError[];
}

/**
 * Compiles an emitter's trail or ribbon (`strip`) graph, drawn in `renderMode`, held to the same
 * checks as the live preview (domain/stripChecks.ts) and the same GPU budget
 * (domain/renderBudget.ts) - counting the GPU backend over `kernelBuffers`, the slot of the GPU
 * kernel the emitter ships, if any.
 */
function compileStrip<K extends StripName>(
  strip: K,
  emitter: EmitterDoc,
  stripGraph: EditorGraph,
  sortInterval: number,
  behaviorAttributes: readonly FXAttributeRequest[],
  kernel: FXCompiledKernel,
  kernelBuffers: readonly FXBufferLayout[] | undefined,
): StripIR<K> {
  const fail = (message: string): never => {
    throw new Error(`exportTypeScript: ${emitter.name} (${strip}): ${message}`);
  };
  const sortError = stripSortError(strip, sortInterval);
  if (sortError !== undefined) {
    fail(sortError.message);
  }
  const graph = buildRenderGraph(stripGraph);
  const config = readStripSinkConfig(strip, stripGraph);
  const renderAttributes = collectAttributeRequests(graph).requests;
  const [attributeError] = stripAttributeErrors(
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
  const shaders = compileForEveryGLSLTier(graph, buildStripTarget(strip, renderAttributes));
  const [budgetError] = stripRenderBudgetFindings(
    strip,
    assembleForEveryGLSLTier(shaders, STRIP_GEOMETRY, renderAttributes, config.renderMode),
    kernel.update.buffers,
    kernelBuffers,
  ).errors;
  if (budgetError !== undefined) {
    fail(budgetError.message);
  }
  return {
    shaders,
    renderAttributes,
    renderMode: config.renderMode,
    fields: stripRuntimeFields(strip, config),
    warnings: [
      ...unwrittenAttributeWarnings(
        graph,
        kernelWrittenBuffers(kernel),
        emitter.behaviorGraph.attributes,
      ),
      ...stripSpawnWarnings(strip, emitter),
    ],
  };
}

/**
 * Compiles one emitter for the export. `spawnConfig` is how it runs - the export passes
 * `effectiveSpawnConfig` (a reaction source is never offered the GPU); defaults to what its spawn
 * node asks for, for an emitter compiled on its own. `library` is the content library's assets - an
 * asset the behavior samples must be one of them.
 */
export function compileEmitter(
  emitter: EmitterDoc,
  spawnConfig: SpawnSinkConfig = readSpawnSinkConfig(emitter.behaviorGraph),
  library: LibraryAssetNames = NO_LIBRARY_ASSETS,
): EmitterIR {
  // A Timeline Value declared at two types or with two defaults across the emitter's graphs.
  const [declarationConflict] = timelineValueConflicts(emitterGraphs(emitter));
  if (declarationConflict !== undefined) {
    throw new Error(`exportTypeScript: ${emitter.name}: ${declarationConflict.error.message}`);
  }
  const renderGraph = buildRenderGraph(emitter.renderGraph);
  const behaviorSnapshot = serializeGraph(emitter.behaviorGraph, GraphKind.Behavior);
  const behaviorGraph = buildBehaviorGraph(behaviorSnapshot);
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
  const hiddenSortError = hiddenParticlesSortError(config);
  if (hiddenSortError !== undefined) {
    throw new Error(`exportTypeScript: ${emitter.name}: ${hiddenSortError.message}`);
  }
  const [assetError] = missingAssetErrors(behaviorGraph, library);
  if (assetError !== undefined) {
    throw new Error(`exportTypeScript: ${emitter.name}: ${assetError.message}`);
  }
  const shaders = compileForEveryGLSLTier(renderGraph, buildParticleTarget(renderAttributes));

  // Compiled before the budget is counted: the GPU kernel's slot layout, when there is one,
  // decides what the Standard tier's particle mesh takes.
  const bundle = compileBehaviorBundle(
    behaviorGraph,
    particleBehaviorTargetsFor(behaviorGraph, spawnConfig.tryGpuSimulation, behaviorAttributes),
  );
  const kernelBuffers = bundle.standardProgram?.buffers;
  // Particles that are not drawn take nothing of a GPU.
  if (config.drawParticles) {
    requireWithinRenderBudget(
      emitter.name,
      emitterRenderBudgetFindings(
        assembleForEveryGLSLTier(
          shaders,
          toArtifactGeometrySource(config.geometry),
          renderAttributes,
          config.renderMode,
        ),
        bundle.kernel.update.buffers,
        {
          castShadow: config.castShadow,
          ...(kernelBuffers === undefined
            ? {}
            : { gpu: { buffers: kernelBuffers, sorted: config.sortInterval > 0 } }),
        },
      ),
    );
  }
  const strip = <K extends StripName>(name: K, graph: EditorGraph): StripIR<K> =>
    compileStrip(
      name,
      emitter,
      graph,
      config.sortInterval,
      behaviorAttributes,
      bundle.kernel,
      kernelBuffers,
    );

  return {
    shaders,
    renderAttributes,
    kernel: bundle.kernel,
    behaviorAttributes,
    gpuProgram: bundle.standardProgram,
    geometry: toArtifactGeometrySource(config.geometry),
    sampledAssets: {
      mesh: [...new Set(Object.values(kernelResources(bundle.kernel, "mesh") ?? {}))],
      volume: [...new Set(Object.values(kernelResources(bundle.kernel, "volume") ?? {}))],
    },
    renderMode: config.renderMode,
    sortInterval: config.sortInterval,
    castShadow: config.castShadow,
    receiveShadow: config.receiveShadow,
    drawParticles: config.drawParticles,
    expectedCapacity: spawnConfig.expectedCapacity,
    ...withMaxLifetime(lifetimeUpperBound(behaviorSnapshot)),
    warnings: [
      ...unwrittenAttributeWarnings(
        renderGraph,
        kernelWrittenBuffers(bundle.kernel),
        emitter.behaviorGraph.attributes,
      ),
      ...unboundedLifetimeWarnings(behaviorSnapshot),
      ...cpuSceneDepthWarnings(behaviorGraph, bundle.standardProgram !== undefined),
      ...emitterDrawsNothingWarnings(emitter),
    ],
    ...Object.fromEntries(
      stripGraphs(emitter).map(({ name, graph }) => [name, strip(name, graph)]),
    ),
  };
}

export interface MeshIR {
  readonly shaders: CompiledShadersByGLSLTier;
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
  requireWithinRenderBudget(
    mesh.name,
    meshRenderBudgetFindings(
      assembleForEveryGLSLTier(
        shaders,
        toArtifactGeometrySource(config.geometry),
        [],
        config.renderMode,
      ),
      config.castShadow,
    ),
  );
  return {
    shaders,
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

function buildBehaviorGraph(snapshot: FXGraphSnapshotData): FXGraph<FXBehaviorNode> {
  return reconcile(new FXGraphReconciler(behaviorRegistry), snapshot);
}

// The optional field is left out, not set to undefined, under exactOptionalPropertyTypes.
function withMaxLifetime(maxLifetime: number | undefined): { maxLifetime?: number } {
  return maxLifetime === undefined ? {} : { maxLifetime };
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
