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
  helpersImportLines,
} from "./artifactLiterals";
import { FXRenderModuleWriter } from "./FXRenderModuleWriter";

export interface FXEmitModuleOptions {
  /** The geometry to instance per particle: a built-in primitive or a custom mesh asset, named.
   *  @defaultValue `{ type: "primitive", primitive: "plane" }` */
  readonly geometry?: FXGeometrySource;
  /** Emitted into the render artifact's `options.renderMode`. @defaultValue `"blending"` */
  readonly renderMode?: FXRenderMode;
  /** Package specifier the emitted module imports types from. @defaultValue `"sparcoon"` */
  readonly importSpecifier?: string;
}

const RENDER_EXPORT_NAMES = { baseline: "renderBaseline", standard: "renderStandard" } as const;

/**
 * Emits an ESM effect module for the graphs. `spawn`/`update` are the same per-particle source the
 * preview builds.
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
  // One artifact per registered GLSL tier, so the runtime can pick by render capability.
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
  const lines = [
    `import { type FXRenderArtifact, type FXBehaviorArtifact } from ${JSON.stringify(importSpecifier)};`,
    ...helpersImportLines(importSpecifier, [
      ...collectBehaviorHelpers(kernel),
      ...collectDrawHelpers(shaders.baseline),
      ...collectDrawHelpers(shaders.standard),
      ...renderWriter.helperNames(),
    ]),
    "",
  ];
  for (const declaration of renderDeclarations) {
    lines.push(declaration);
    lines.push("");
  }
  lines.push(`export const behavior: FXBehaviorArtifact = ${behaviorArtifactBody(kernel)};`);
  return lines.join("\n") + "\n";
}
