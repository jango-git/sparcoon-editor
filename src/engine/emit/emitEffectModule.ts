import type { FXGeometrySource, FXRenderMode } from "sparcoon";

import type { FXBehaviorNode } from "../behavior/FXBehaviorNode";
import { compileBehavior } from "../behavior/FXParticleBehaviorKernel.Internal";
import { particleBehaviorTargetsFor } from "../behavior/FXParticleBehaviorTarget";
import { collectAttributeRequests } from "../core/compiler/collectAttributeRequests";
import type { FXGraph } from "../core/FXGraph";
import type { FXCompiledShader } from "../render/compiler/FXCompiledShader";
import { FX_GLSL_RENDER_COMPILERS } from "../render/compiler/FXRenderCompilers";
import type { FXRenderNode } from "../render/FXRenderNode";
import { buildParticleTarget } from "../render/target/FXParticleRenderTarget";
import {
  behaviorArtifactBody,
  collectBehaviorHelpers,
  collectDrawHelpers,
} from "./artifactLiterals";
import { FXRenderModuleWriter } from "./FXRenderModuleWriter";

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

  const behaviorAttributes = collectAttributeRequests(behaviorGraph).requests;
  const kernel = compileBehavior(
    behaviorGraph,
    particleBehaviorTargetsFor(behaviorGraph, false, behaviorAttributes),
  );

  const lines: string[] = [];
  lines.push(
    `import { type FXRenderArtifact, type FXBehaviorArtifact } from ${JSON.stringify(importSpecifier)};`,
  );
  lines.push("");
  // The behavior's helpers and the draw stage's, each once.
  const helpers = new Set([
    ...collectBehaviorHelpers(kernel),
    ...collectDrawHelpers(shaders.baseline),
    ...collectDrawHelpers(shaders.standard),
  ]);
  for (const helper of helpers) {
    lines.push(helper);
    lines.push("");
  }
  const renderWriter = new FXRenderModuleWriter("export const");
  const renderDeclarations = renderWriter.tierDeclarations(
    (["baseline", "standard"] as const).map((tier) => ({
      name: RENDER_EXPORT_NAMES[tier],
      shader: shaders[tier],
    })),
    geometry,
    renderAttributes,
    renderMode,
  );
  // The helpers first: the artifacts below name them.
  for (const declaration of [...renderWriter.helperDeclarations(), ...renderDeclarations]) {
    lines.push(declaration);
    lines.push("");
  }
  lines.push(`export const behavior: FXBehaviorArtifact = ${behaviorArtifactBody(kernel)};`);
  return lines.join("\n") + "\n";
}
