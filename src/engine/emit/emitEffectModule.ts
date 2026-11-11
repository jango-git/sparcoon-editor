import type { FXGraph } from "../core/FXGraph";
import type { FXRenderNode } from "../render/FXRenderNode";
import type { FXBehaviorNode } from "../behavior/FXBehaviorNode";
import type { FXGeometrySource, FXRenderMode } from "sparcoon";
import type { FXCompiledShader } from "../render/compiler/FXCompiledShader";
import { FX_GLSL_RENDER_COMPILERS } from "../render/compiler/FXRenderCompilers";
import { buildParticleTarget } from "../render/target/FXParticleRenderTarget";
import { collectAttributeRequests } from "../core/compiler/collectAttributeRequests";
import { collectRenderCapabilities } from "../core/compiler/collectRenderCapabilities";
import { compileBehavior } from "../behavior/FXParticleBehaviorKernel.Internal";
import { buildParticleBehaviorTargets } from "../behavior/FXParticleBehaviorTarget";
import {
  behaviorArtifactBody,
  collectBehaviorHelpers,
  renderArtifactBody,
  renderArtifactDeclarations,
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

/** The module's export name for each tier's render artifact, in tier order. */
const RENDER_EXPORT_NAMES = { baseline: "renderBaseline", standard: "renderStandard" } as const;

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
  const capabilities = collectRenderCapabilities(renderGraph);

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
  for (const declaration of renderArtifactDeclarations(
    (["baseline", "standard"] as const).map((tier) => ({
      name: RENDER_EXPORT_NAMES[tier],
      body: renderArtifactBody(shaders[tier], capabilities, geometry, renderAttributes, renderMode),
    })),
    "export const",
  )) {
    lines.push(declaration);
    lines.push("");
  }
  lines.push(`export const behavior: FXBehaviorArtifact = ${behaviorArtifactBody(kernel)};`);
  return lines.join("\n") + "\n";
}
