import type { FXGeometrySource, FXRenderMode } from "sparcoon";

import type { FXGLSLHelperName } from "../core/ir/FXHelpers.Internal";
import type { FXAttributeRequest } from "../core/socket/FXAttribute";
import type { FXCompiledShader, FXCompiledStage } from "../render/compiler/FXCompiledShader";
import type { FXRenderStagePath, FXStagePrinter } from "./artifactLiterals";
import { collectShaderHelpers, renderArtifactBody } from "./artifactLiterals";
import { lineDeltaLiteral } from "./lineDelta";

export interface FXTierArtifact {
  readonly name: string;
  readonly shader: FXCompiledShader;
}

/**
 * Writes the render artifacts of a module. Helpers are imported, and a later tier reuses an earlier
 * tier's stage lines where they agree.
 */
export class FXRenderModuleWriter {
  private readonly helpers = new Set<FXGLSLHelperName>();

  constructor(private readonly keyword: "const" | "export const" = "const") {}

  public helperNames(): readonly FXGLSLHelperName[] {
    return [...this.helpers];
  }

  public tierDeclarations(
    tiers: readonly FXTierArtifact[],
    geometry: FXGeometrySource,
    attributes: readonly FXAttributeRequest[],
    renderMode: FXRenderMode,
  ): string[] {
    const [first, ...rest] = tiers;
    if (first === undefined) {
      return [];
    }
    for (const tier of tiers) {
      for (const helper of collectShaderHelpers(tier.shader)) {
        this.helpers.add(helper);
      }
    }
    const firstBody = renderArtifactBody(first.shader, geometry, attributes, renderMode);
    const declarations = [this.declaration(first.name, firstBody)];
    for (const tier of rest) {
      const body = renderArtifactBody(tier.shader, geometry, attributes, renderMode);
      if (body === firstBody) {
        declarations.push(this.declaration(tier.name, first.name));
        continue;
      }
      const shared = renderArtifactBody(
        tier.shader,
        geometry,
        attributes,
        renderMode,
        this.sharedStages(first),
      );
      declarations.push(this.declaration(tier.name, shared.length < body.length ? shared : body));
    }
    return declarations;
  }

  private declaration(name: string, value: string): string {
    return `${this.keyword} ${name}: FXRenderArtifact = ${value};`;
  }

  private sharedStages(base: FXTierArtifact): FXStagePrinter {
    const baseStage = (path: FXRenderStagePath): FXCompiledStage | undefined =>
      base.shader[path.program]?.[path.stage];
    return {
      body: (path, body): string => {
        const stage = baseStage(path);
        return stage === undefined
          ? JSON.stringify(body)
          : lineDeltaLiteral(
              body.map((line) => JSON.stringify(line)),
              stage.body.map((line) => JSON.stringify(line)),
              `${base.name}.${path.program}.${path.stage}.body`,
            );
      },
    };
  }
}
