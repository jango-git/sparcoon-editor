import type { FXGeometrySource, FXRenderMode } from "sparcoon";

import type { FXAttributeRequest } from "../core/socket/FXAttribute";
import type { FXCompiledShader, FXCompiledStage } from "../render/compiler/FXCompiledShader";
import type { FXRenderStagePath, FXStagePrinter } from "./artifactLiterals";
import { renderArtifactBody } from "./artifactLiterals";
import { lineDeltaLiteral } from "./lineDelta";

/** One tier's artifact of an entity: the constant it is declared as, and what it compiled to. */
export interface FXTierArtifact {
  readonly name: string;
  readonly shader: FXCompiledShader;
}

/**
 * Writes the render artifacts of one emitted module, so it carries each piece of GLSL as few times
 * as it can: every distinct helper the module's artifacts use is declared once (see
 * {@link helperDeclarations}) and each artifact names it; of one entity's artifacts per tier, a
 * later tier word for word the first names it, and one that differs takes the first's lines where
 * they agree - the tiers' compilers emit mostly the same code.
 */
export class FXRenderModuleWriter {
  /** Helper source -> the constant declaring it. */
  private readonly helpers = new Map<string, string>();

  constructor(private readonly keyword: "const" | "export const" = "const") {}

  /** The helper constants every artifact written so far names: to place before the first. */
  public helperDeclarations(): string[] {
    return [...this.helpers].map(([source, name]) => `const ${name} = ${JSON.stringify(source)};`);
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
    const pooled = this.pooledStages();
    const firstBody = renderArtifactBody(first.shader, geometry, attributes, renderMode, pooled);
    const declarations = [this.declaration(first.name, firstBody)];
    for (const tier of rest) {
      const body = renderArtifactBody(tier.shader, geometry, attributes, renderMode, pooled);
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

  /** Helpers by their pooled constants, every line written out. */
  private pooledStages(): FXStagePrinter {
    return {
      helpers: (_stage, helperFunctions) => this.helperList(helperFunctions),
      body: (_stage, body) => JSON.stringify(body),
    };
  }

  /** {@link pooledStages}, each stage's lines taken from `base`'s same stage where they agree. */
  private sharedStages(base: FXTierArtifact): FXStagePrinter {
    const baseStage = (path: FXRenderStagePath): FXCompiledStage | undefined =>
      base.shader[path.program]?.[path.stage];
    return {
      helpers: (_stage, helperFunctions) => this.helperList(helperFunctions),
      body: (path, body): string => {
        const stage = baseStage(path);
        return stage === undefined
          ? JSON.stringify(body)
          : lineDeltaLiteral(body, stage.body, `${base.name}.${path.program}.${path.stage}.body`);
      },
    };
  }

  private helperList(helperFunctions: readonly string[]): string {
    return `[${helperFunctions.map((source) => this.helperName(source)).join(", ")}]`;
  }

  private helperName(source: string): string {
    let name = this.helpers.get(source);
    if (name === undefined) {
      name = `glslHelper${String(this.helpers.size)}`;
      this.helpers.set(source, name);
    }
    return name;
  }
}
