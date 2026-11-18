import type { FXGeometrySource, FXRenderMode } from "sparcoon";

import type { FXGLSLHelperName } from "../core/ir/FXHelpers.Internal";
import type { FXAttributeRequest } from "../core/socket/FXAttribute";
import type { FXCompiledShader, FXCompiledStage } from "../render/compiler/FXCompiledShader";
import type { FXRenderStagePath, FXStagePrinter } from "./artifactLiterals";
import { collectShaderHelpers, renderArtifactBody } from "./artifactLiterals";
import { lineDeltaLiteral } from "./lineDelta";

/** One tier's artifact of an entity: the constant it is declared as, and what it compiled to. */
export interface FXTierArtifact {
  readonly name: string;
  readonly shader: FXCompiledShader;
}

/**
 * Writes the render artifacts of one emitted module, so it carries each piece of GLSL as few times
 * as it can: a helper is named, imported from `sparcoon/helpers` (see {@link helperNames}); of one
 * entity's artifacts per tier, a later tier word for word the first names it, and one that differs
 * takes the first's lines where they agree - the tiers' compilers emit mostly the same code.
 */
export class FXRenderModuleWriter {
  private readonly helpers = new Set<FXGLSLHelperName>();

  constructor(private readonly keyword: "const" | "export const" = "const") {}

  /** The helpers every artifact written so far names, for the module to import. */
  public helperNames(): readonly FXGLSLHelperName[] {
    return [...this.helpers];
  }

  /** One declaration per tier, in tier order (see the class doc). */
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

  /** Each stage's lines taken from `base`'s same stage where they agree. */
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
