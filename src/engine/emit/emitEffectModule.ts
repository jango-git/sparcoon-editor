import type { FXGraph } from "../core/FXGraph";
import type { FXRenderNode } from "../render/FXRenderNode";
import type { FXBehaviorNode } from "../behavior/FXBehaviorNode";
import type { FXGeometrySource, FXRenderMode } from "sparcoon";
import type { FXCompiledShader } from "../render/compiler/FXCompiledShader";
import { FX_GLSL_RENDER_COMPILERS } from "../render/compiler/FXRenderCompilers";
import { buildParticleTarget } from "../render/target/FXParticleRenderTarget";
import { collectAttributeRequests } from "../core/compiler/collectAttributeRequests";
import { collectLightingRequirements } from "../core/compiler/collectLightingRequirements";
import { compileBehavior } from "../behavior/FXParticleBehaviorKernel.Internal";
import { buildParticleBehaviorTargets } from "../behavior/FXParticleBehaviorTarget";
import {
  behaviorArtifactBody,
  collectBehaviorHelpers,
  renderArtifactBody,
} from "./artifactLiterals";

/** Options for {@link emitEffectModule}. */
export interface FXEmitModuleOptions {
  /** The geometry to instance per particle: a built-in primitive or a custom mesh asset, named.
   *  @defaultValue `{ type: "primitive", primitive: "plane" }` */
  readonly geometry?: FXGeometrySource;
  /** Emitted into the render artifact's `options.renderMode`. @defaultValue `"blending"` */
  readonly renderMode?: FXRenderMode;
  /** Package specifier the emitted module imports types from. @defaultValue `"sparcoon"` */
  readonly importSpecifier?: string;
}

/**
 * Turns a render + behavior graph into a ready-to-import ESM effect module (text). The runtime
 * only executes the result (`FXEmitter.fromArtifacts`) - no graph, compiler, or `eval` at runtime.
 *
 * The emitted `spawn`/`update` are real authored functions carrying the exact per-particle source
 * the kernel builder would have `new Function`-d, with math helpers hoisted to module scope.
 */
export function emitEffectModule(
  renderGraph: FXGraph<FXRenderNode>,
  behaviorGraph: FXGraph<FXBehaviorNode>,
  options: FXEmitModuleOptions = {},
): string {
  const geometry: FXGeometrySource = options.geometry ?? { type: "primitive", primitive: "plane" };
  const renderMode = options.renderMode ?? "blending";
  const importSpecifier = options.importSpecifier ?? "sparcoon";

  const renderAttributes = collectAttributeRequests(renderGraph).requests;
  const renderTarget = buildParticleTarget(renderAttributes);
  // Every registered GLSL-family render compiler (today baseline/standard), so the module
  // exports both tiers the runtime can pick between by render capability.
  const shaders = Object.fromEntries(
    Object.entries(FX_GLSL_RENDER_COMPILERS).map(
      ([id, compiler]) => [id, compiler.compile(renderGraph, renderTarget)] as const,
    ),
  ) as Readonly<Record<keyof typeof FX_GLSL_RENDER_COMPILERS, FXCompiledShader>>;
  const lightingIntrinsics = collectLightingRequirements(renderGraph);

  const behaviorAttributes = collectAttributeRequests(behaviorGraph).requests;
  const kernel = compileBehavior(behaviorGraph, buildParticleBehaviorTargets(behaviorAttributes));

  const lines: string[] = [];
  lines.push(
    `import { type FXRenderArtifact, type FXBehaviorArtifact } from ${JSON.stringify(importSpecifier)};`,
  );
  lines.push("");
  for (const helper of collectBehaviorHelpers(kernel)) {
    lines.push(helper);
    lines.push("");
  }
  lines.push(
    `export const renderBaseline: FXRenderArtifact = ${renderArtifactBody(shaders.baseline, lightingIntrinsics, geometry, renderAttributes, renderMode)};`,
  );
  lines.push("");
  lines.push(
    `export const renderStandard: FXRenderArtifact = ${renderArtifactBody(shaders.standard, lightingIntrinsics, geometry, renderAttributes, renderMode)};`,
  );
  lines.push("");
  lines.push(
    `export const behavior: FXBehaviorArtifact = ${behaviorArtifactBody(kernel, behaviorAttributes)};`,
  );
  return lines.join("\n") + "\n";
}
