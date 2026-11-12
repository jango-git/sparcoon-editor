import { fxExternalSampleFunction } from "sparcoon/editor";
import { FXCompilerErrorException } from "../../core/compiler/FXCompilerError";
import { FXShaderStage } from "../FXShaderStage";
import type { FXCompiledStage, FXUniformDescriptor, FXUniformHandle } from "./FXCompiledShader";

/**
 * The shading-language-neutral parts both GLSL tiers' compile pipelines share - each pipeline
 * stays its own (see `FXCompilePipelineStandard.Internal.ts`), and calls these where they agree.
 */

/** What a target output slot reads: a local's name (or an opaque value's code), in its stage. */
export interface FXSlotValue {
  readonly stage: FXShaderStage;
  readonly value: string;
}

/** A stage as a tier printed it, before its uniform declarations are known. */
export type FXPrintedStage = Omit<FXCompiledStage, "uniformDeclarations">;

/** One render compile's uniforms, by name, in declaration order. */
export class FXRenderUniforms {
  private readonly byName = new Map<string, FXUniformHandle>();

  /** `nextName` is the compile's own name source, for a uniform with no forced name. */
  constructor(private readonly nextName: () => string) {}

  public get handles(): readonly FXUniformHandle[] {
    return [...this.byName.values()];
  }

  /**
   * Declares a uniform. A forced name (a param slot) is used verbatim and deduped, so two param
   * nodes of the same name share one uniform (and a name survives structural edits -
   * timeline-addressable); a type clash between them is a compile error. Otherwise auto-named.
   */
  public allocate(descriptor: FXUniformDescriptor): FXUniformHandle {
    if (descriptor.name !== undefined) {
      const glslType = descriptor.type.glslTypeName;
      const existing = this.byName.get(descriptor.name);
      if (existing !== undefined) {
        const priorType = existing.type.glslTypeName;
        if (priorType !== glslType) {
          throw new FXCompilerErrorException({
            code: "param-uniform-type-conflict",
            message: `param uniform "${descriptor.name}" is declared as both ${priorType} and ${glslType}`,
            params: { name: descriptor.name, priorType, newType: glslType },
          });
        }
        return existing;
      }
      const handle: FXUniformHandle =
        descriptor.external === true
          ? {
              name: descriptor.name,
              type: descriptor.type,
              value: descriptor.value,
              external: descriptor.name,
            }
          : { name: descriptor.name, type: descriptor.type, value: descriptor.value };
      this.byName.set(descriptor.name, handle);
      return handle;
    }
    const name = this.nextName();
    const handle: FXUniformHandle = { name, type: descriptor.type, value: descriptor.value };
    this.byName.set(name, handle);
    return handle;
  }

  /** Every uniform by its name - the compiled shader's `uniforms`. */
  public record(): Record<string, FXUniformHandle> {
    return Object.fromEntries(this.byName);
  }
}

/** A placed render graph's two printed stages, and how its output slots read them. */
export interface FXPlacedStages {
  readonly vertex: FXPrintedStage;
  readonly fragment: FXPrintedStage;
  /** The vertex statements writing what crosses to the fragment stage, after its body. */
  readonly varyingWrites: readonly string[];
  /** The varying each crossing local is read through in the fragment stage, by the local. */
  readonly carried: ReadonlyMap<string, string>;
  /** The draw uniform a slot now reads, by the lifted local it read (see `liftDrawStage`). */
  readonly renamed: ReadonlyMap<string, string>;
}

/**
 * The compiled stages and output expressions of a placed render graph: each slot reads its value
 * through the draw uniform it was lifted to, or (in the fragment stage) the varying it crosses
 * by, and each stage declares the uniforms its code - helpers, body and outputs - reads.
 */
export function finishRenderStages(
  placed: FXPlacedStages,
  slots: ReadonlyMap<string, FXSlotValue>,
  uniforms: readonly FXUniformHandle[],
): {
  readonly vertex: FXCompiledStage;
  readonly fragment: FXCompiledStage;
  readonly outputs: Record<string, string>;
} {
  const outputs: Record<string, string> = {};
  for (const [slot, { stage, value }] of slots) {
    const read = placed.renamed.get(value) ?? value;
    outputs[slot] = stage === FXShaderStage.FRAGMENT ? (placed.carried.get(read) ?? read) : read;
  }
  const outputsOf = (stage: FXShaderStage): string[] =>
    [...slots].filter(([, slot]) => slot.stage === stage).map(([slot]) => outputs[slot] ?? "");
  const finish = (printed: FXPrintedStage, stage: FXShaderStage): FXCompiledStage => ({
    ...printed,
    uniformDeclarations: stageUniformDeclarations(uniforms, [
      ...printed.helperFunctions,
      ...printed.body,
      ...outputsOf(stage),
    ]),
  });
  return {
    vertex: finish(
      { ...placed.vertex, body: [...placed.vertex.body, ...placed.varyingWrites] },
      FXShaderStage.VERTEX,
    ),
    fragment: finish(placed.fragment, FXShaderStage.FRAGMENT),
    outputs,
  };
}

/**
 * The `uniform <type> <name>;` declarations of each of `uniforms` that one stage's printed
 * `code` - its helpers, body and outputs - reads, in declaration order: the runtime declares in a
 * stage only what it reads there, so it charges a stage nothing for what only the other one uses
 * (a sampler the vertex stage never reads costs it no texture unit). An external sampler is read
 * through its runtime-defined sampling function. Both GLSL tiers declare a uniform alike.
 */
export function stageUniformDeclarations(
  uniforms: Iterable<FXUniformHandle>,
  code: readonly string[],
): string[] {
  const identifiers = new Set(code.join("\n").match(/[A-Za-z_]\w*/g) ?? []);
  const declarations: string[] = [];
  for (const handle of uniforms) {
    const read =
      identifiers.has(handle.name) ||
      (handle.external !== undefined && identifiers.has(fxExternalSampleFunction(handle.name)));
    if (read) {
      declarations.push(`uniform ${handle.type.glslTypeName} ${handle.name};`);
    }
  }
  return declarations;
}
