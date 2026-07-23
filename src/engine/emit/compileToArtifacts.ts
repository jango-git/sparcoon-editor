import type { FXGraph } from "../core/FXGraph";
import type { FXRenderNode } from "../render/FXRenderNode";
import type { FXBehaviorNode } from "../behavior/FXBehaviorNode";
import type { FXCompiledShader } from "../render/compiler/FXCompiledShader";
import type { FXCompiledKernel, FXCompiledKernelPhase } from "../behavior/FXCompiledKernel";
import type {
  FXBehaviorArtifact,
  FXGeometrySource,
  FXRenderArtifact,
  FXRenderMode,
} from "sparcoon";
import type { FXApplyValues } from "sparcoon/editor";
import type { Texture } from "three";
import type { FXAttributeRequest } from "../core/socket/FXAttribute";
import type { FXCompilerError } from "../core/compiler/FXCompilerError";
import { FXCompilerErrorException } from "../core/compiler/FXCompilerError";
import { FXCompilerBaseline } from "../render/compiler/FXCompilerBaseline";
import { buildParticleTarget } from "../render/target/FXParticleRenderTarget";
import { collectLightingRequirements } from "../core/compiler/collectLightingRequirements";
import type { FXAttributeCollection } from "../core/compiler/collectAttributeRequests";
import {
  collectAttributeRequests,
  mergeAttributeCollections,
} from "../core/compiler/collectAttributeRequests";
import { compileBehavior, validateBehavior } from "../behavior/FXParticleBehaviorKernel.Internal";
import { buildParticleBehaviorTargets } from "../behavior/FXParticleBehaviorTarget";
import { assembleBehaviorArtifact, assembleRenderArtifact } from "./assembleArtifacts";

/**
 * Compiles a render + behavior graph into **in-memory artifact objects** (not module
 * text). This is the sibling of {@link emitEffectModule}: the module emitter serializes
 * the same `FXCompilerBaseline` / `compileBehavior` output to an ESM string for shipping, while
 * this returns live `{ render, behavior }` objects the editor hands straight to
 * `FXEmitter.fromArtifacts` for a preview.
 *
 * The behavior `spawn`/`update` are built here as **real functions** via the engine's
 * `new Function` kernel builders (`buildParticleSpawnKernel` / `buildParticleUpdateKernel`)
 * - the same byte-identical per-particle source the module emitter would print. `eval`
 * is allowed in the editor; only the runtime forbids it (it receives finished functions).
 *
 * Texture uniforms cross as their live `Texture` object (the module emitter cannot
 * serialize those to text, so this in-memory path is strictly more capable for a preview).
 */
export interface FXCompileArtifactsOptions {
  /** The geometry to instance per particle: a built-in primitive (`"plane"` + a camera-facing
   *  `particleTransform` is the billboard) or a custom mesh asset. @defaultValue `{ type:
   *  "primitive", primitive: "plane" }` */
  readonly geometry?: FXGeometrySource;
  /** How the particle fragment's alpha composites into the framebuffer. @defaultValue
   *  `"blending"` */
  readonly renderMode?: FXRenderMode;
}

export interface FXCompiledArtifacts {
  readonly render: FXRenderArtifact;
  readonly behavior: FXBehaviorArtifact;
  /** Combined structural hash of both graphs. Equal across two compiles => the compiled
   *  GLSL/kernel is identical and only values changed, so the editor can rebind instead
   *  of rebuilding the emitter. */
  readonly hash: string;
}

interface CompiledGraphs {
  /** Lighting capability derived from the render graph: the shade intrinsics its nodes call. */
  readonly lightingIntrinsics: readonly string[];
  readonly shader: FXCompiledShader;
  readonly kernel: FXCompiledKernel;
  readonly renderAttributes: readonly FXAttributeRequest[];
  readonly behaviorAttributes: readonly FXAttributeRequest[];
}

/** Attribute type conflicts that surface only across the two graphs (a name written by behavior
 *  and read by render at different types) - each graph's own `collectAttributeRequests` is blind
 *  to the other, so neither would ever catch this alone. */
function crossGraphAttributeErrors(
  render: FXAttributeCollection,
  behavior: FXAttributeCollection,
): readonly FXCompilerError[] {
  // mergeAttributeCollections returns [...render.errors, ...behavior.errors, ...cross], so this
  // offset is exactly the tail past the two inputs' own errors.
  const merged = mergeAttributeCollections(render, behavior);
  return merged.errors.slice(render.errors.length + behavior.errors.length);
}

function compileGraphs(
  renderGraph: FXGraph<FXRenderNode>,
  behaviorGraph: FXGraph<FXBehaviorNode>,
): CompiledGraphs {
  const renderCollection = collectAttributeRequests(renderGraph);
  const behaviorCollection = collectAttributeRequests(behaviorGraph);
  const [firstCrossError] = crossGraphAttributeErrors(renderCollection, behaviorCollection);
  if (firstCrossError !== undefined) {
    // Refuse to emit a corrupt artifact; compileToArtifacts throws the first error.
    throw new FXCompilerErrorException(firstCrossError);
  }

  const renderAttributes = renderCollection.requests;
  const renderTarget = buildParticleTarget(renderAttributes);
  const shader = new FXCompilerBaseline().compile(renderGraph, renderTarget);
  const lightingIntrinsics = collectLightingRequirements(renderGraph);

  const behaviorAttributes = behaviorCollection.requests;
  const kernel = compileBehavior(behaviorGraph, buildParticleBehaviorTargets(behaviorAttributes));

  return { lightingIntrinsics, shader, kernel, renderAttributes, behaviorAttributes };
}

/**
 * Compiles both graphs to the two artifacts the runtime executes. A structural edit in
 * the editor re-runs this and hands the result to a fresh `FXEmitter.fromArtifacts`.
 */
export function compileToArtifacts(
  renderGraph: FXGraph<FXRenderNode>,
  behaviorGraph: FXGraph<FXBehaviorNode>,
  options: FXCompileArtifactsOptions = {},
): FXCompiledArtifacts {
  const compiled = compileGraphs(renderGraph, behaviorGraph);
  const renderMode = options.renderMode ?? "blending";
  const geometry: FXGeometrySource = options.geometry ?? { type: "primitive", primitive: "plane" };
  return {
    // Delegates to the shared in-memory assembler `compileMeshArtifact.ts` also uses.
    render: assembleRenderArtifact(
      compiled.shader,
      compiled.lightingIntrinsics,
      geometry,
      compiled.renderAttributes,
      renderMode,
    ),
    behavior: assembleBehaviorArtifact(compiled.kernel, compiled.behaviorAttributes),
    // renderMode/geometry reshape the runtime material, not our compiled shader, so neither
    // moves the shader hash; fold them in so toggling either counts as structural.
    hash: `${compiled.shader.hash}::${compiled.kernel.hash}::rm-${renderMode}::geo-${JSON.stringify(geometry)}`,
  };
}

/** Every validation problem of the two graphs, split by graph. Unlike {@link compileToArtifacts}
 *  (which throws the first error), this collects them all. */
export interface FXArtifactValidation {
  readonly render: readonly FXCompilerError[];
  readonly behavior: readonly FXCompilerError[];
}

/** Validates both graphs against the same targets {@link compileToArtifacts} compiles against,
 *  without throwing - intended for the editor to light up the responsible nodes. */
export function validateArtifacts(
  renderGraph: FXGraph<FXRenderNode>,
  behaviorGraph: FXGraph<FXBehaviorNode>,
): FXArtifactValidation {
  const renderCollection = collectAttributeRequests(renderGraph);
  const behaviorCollection = collectAttributeRequests(behaviorGraph);
  const renderTarget = buildParticleTarget(renderCollection.requests);
  const behaviorTargets = buildParticleBehaviorTargets(behaviorCollection.requests);
  // A cross-graph attribute conflict belongs to neither graph's own validation; surface it so
  // the editor's error lights match what compileToArtifacts would throw on.
  const crossErrors = crossGraphAttributeErrors(renderCollection, behaviorCollection);
  return {
    render: new FXCompilerBaseline().validate(renderGraph, renderTarget).errors,
    behavior: [...crossErrors, ...validateBehavior(behaviorGraph, behaviorTargets).errors],
  };
}

/** Projects the current uniform/binding values for a value edit (a rebind), keyed by the same
 *  slot names the installed artifact uses. Feeds `FXEmitter.applyValues` for a shader/kernel-free
 *  color/speed/curve tweak. */
export function collectValues(
  renderGraph: FXGraph<FXRenderNode>,
  behaviorGraph: FXGraph<FXBehaviorNode>,
): FXApplyValues {
  const { shader, kernel } = compileGraphs(renderGraph, behaviorGraph);

  const uniforms: Record<string, number | readonly number[] | Texture> = {};
  for (const [name, handle] of Object.entries(shader.uniforms)) {
    // An external sampler (a Texture) carries no editor-owned value - the host binds
    // it by slot name - so it takes no part in a value-only rebind.
    if (handle.external !== undefined) {
      continue;
    }
    uniforms[name] = handle.value as number | readonly number[] | Texture;
  }

  const bindings: Record<string, number | Float32Array> = {};
  collectPhaseBindings(kernel.spawn, bindings);
  collectPhaseBindings(kernel.update, bindings);

  return { uniforms, bindings };
}

function collectPhaseBindings(
  phase: FXCompiledKernelPhase | undefined,
  into: Record<string, number | Float32Array>,
): void {
  if (phase === undefined) {
    return;
  }
  for (const [name, handle] of Object.entries(phase.bindings)) {
    const existing = into[name];
    if (existing !== undefined && existing !== handle.value) {
      throw new Error(
        `compileToArtifacts: binding "${name}" has conflicting values across the spawn and update phases`,
      );
    }
    into[name] = handle.value;
  }
}
