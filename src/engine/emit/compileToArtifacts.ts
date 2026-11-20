import type {
  FXBehaviorArtifact,
  FXGeometrySource,
  FXRenderArtifact,
  FXRenderMode,
} from "sparcoon";
import type { FXApplyValues } from "sparcoon/editor";
import type { Texture } from "three";

import type { FXBehaviorNode } from "../behavior/FXBehaviorNode";
import type { FXCompiledKernel, FXCompiledKernelPhase } from "../behavior/FXCompiledKernel";
import { compileBehavior, validateBehavior } from "../behavior/FXParticleBehaviorKernel.Internal";
import { particleBehaviorTargetsFor } from "../behavior/FXParticleBehaviorTarget";
import type { FXAttributeCollection } from "../core/compiler/collectAttributeRequests";
import {
  collectAttributeRequests,
  mergeAttributeCollections,
} from "../core/compiler/collectAttributeRequests";
import type { FXCompilerError } from "../core/compiler/FXCompilerError";
import { FXCompilerErrorException } from "../core/compiler/FXCompilerError";
import type { FXGraph } from "../core/FXGraph";
import type { FXAttributeRequest } from "../core/socket/FXAttribute";
import type { FXCompiledShader } from "../render/compiler/FXCompiledShader";
import { FXCompilerBaseline } from "../render/compiler/FXCompilerBaseline";
import type { FXRenderNode } from "../render/FXRenderNode";
import { buildParticleTarget } from "../render/target/FXParticleRenderTarget";
import { assembleBehaviorArtifact, assembleRenderArtifact } from "./assembleArtifacts";

/**
 * Compiles both graphs into live `{ render, behavior }` objects for `FXEmitter.fromArtifacts`.
 * Texture uniforms keep their `Texture`, which module text cannot carry. `spawn`/`update` are built
 * with `new Function`, from the same source emitEffectModule prints.
 */
export interface FXCompileArtifactsOptions {
  /**
   * Geometry to instance per particle. A `"plane"` primitive with a camera-facing
   * `particleTransform` is the billboard.
   */
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
  readonly shader: FXCompiledShader;
  readonly kernel: FXCompiledKernel;
  readonly renderAttributes: readonly FXAttributeRequest[];
  readonly behaviorAttributes: readonly FXAttributeRequest[];
}

/**
 * Attribute type conflicts across the two graphs (written by behavior, read by render at another
 * type).
 */
function crossGraphAttributeErrors(
  render: FXAttributeCollection,
  behavior: FXAttributeCollection,
): readonly FXCompilerError[] {
  // The cross-graph errors follow the two graphs' own, so skip those.
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
    throw new FXCompilerErrorException(firstCrossError);
  }

  const renderAttributes = renderCollection.requests;
  const renderTarget = buildParticleTarget(renderAttributes);
  const shader = new FXCompilerBaseline().compile(renderGraph, renderTarget);

  const behaviorAttributes = behaviorCollection.requests;
  const kernel = compileBehavior(
    behaviorGraph,
    particleBehaviorTargetsFor(behaviorGraph, false, behaviorAttributes),
  );

  return { shader, kernel, renderAttributes, behaviorAttributes };
}

export function compileToArtifacts(
  renderGraph: FXGraph<FXRenderNode>,
  behaviorGraph: FXGraph<FXBehaviorNode>,
  options: FXCompileArtifactsOptions = {},
): FXCompiledArtifacts {
  const compiled = compileGraphs(renderGraph, behaviorGraph);
  const renderMode = options.renderMode ?? "blending";
  const geometry: FXGeometrySource = options.geometry ?? { type: "primitive", primitive: "plane" };
  return {
    render: assembleRenderArtifact(
      compiled.shader,
      geometry,
      compiled.renderAttributes,
      renderMode,
    ),
    behavior: assembleBehaviorArtifact(compiled.kernel),
    // renderMode and geometry change the material, not the shader hash, so fold them in.
    hash: `${compiled.shader.hash}::${compiled.kernel.hash}::rm-${renderMode}::geo-${JSON.stringify(geometry)}`,
  };
}

export interface FXArtifactValidation {
  readonly render: readonly FXCompilerError[];
  readonly behavior: readonly FXCompilerError[];
}

/** Validates both graphs without throwing, for error lights on nodes. */
export function validateArtifacts(
  renderGraph: FXGraph<FXRenderNode>,
  behaviorGraph: FXGraph<FXBehaviorNode>,
): FXArtifactValidation {
  const renderCollection = collectAttributeRequests(renderGraph);
  const behaviorCollection = collectAttributeRequests(behaviorGraph);
  const renderTarget = buildParticleTarget(renderCollection.requests);
  const behaviorTargets = particleBehaviorTargetsFor(
    behaviorGraph,
    false,
    behaviorCollection.requests,
  );
  const crossErrors = crossGraphAttributeErrors(renderCollection, behaviorCollection);
  return {
    render: new FXCompilerBaseline().validate(renderGraph, renderTarget).errors,
    behavior: [...crossErrors, ...validateBehavior(behaviorGraph, behaviorTargets).errors],
  };
}

/** Current uniform and binding values by slot name, for `FXEmitter.applyValues`. */
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
