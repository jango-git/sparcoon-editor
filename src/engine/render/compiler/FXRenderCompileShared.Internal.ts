import { fxExternalSampleFunction } from "sparcoon/editor";

import type { FXTypedLocal } from "../../core/codegen/drawStage.Internal";
import { componentIndices } from "../../core/codegen/projectComponents.Internal";
import type { FXRenderCapabilities } from "../../core/compiler/collectRenderCapabilities";
import { FXCompilerErrorException } from "../../core/compiler/FXCompilerError";
import { isImpureFunction } from "../../core/ir/FXFunctions.Internal";
import type { FXValueType } from "../../core/socket/FXValueType";
import { FXShaderStage } from "../FXShaderStage";
import type { FXTarget } from "../target/FXTarget";
import type {
  FXCompiledProgram,
  FXCompiledShader,
  FXCompiledStage,
  FXUniformDescriptor,
  FXUniformHandle,
  FXVarying,
} from "./FXCompiledShader";
import { zeroValue } from "./FXCompiledShader";
import type { FXGLSLRenderTier } from "./FXRenderCompilers";
import type { FXPlacedProgram } from "./FXRenderStagePlacement.Internal";
import { placeRenderStages } from "./FXRenderStagePlacement.Internal";

/**
 * The shading-language-neutral parts both GLSL tiers' compile pipelines share - each pipeline
 * stays its own (see `FXCompilePipelineStandard.Internal.ts`), and calls these where they agree.
 */

/** What a target output slot reads: a local's name (or an opaque value's code), in its stage. */
export interface FXSlotValue {
  readonly stage: FXShaderStage;
  readonly value: string;
}

/** The slots of a graph's color program among its bound `slots`: all but those only `target`'s
 *  shadow program reads (`FXTargetOutput.shadowOnly`). */
export function colorSlots(
  target: FXTarget,
  slots: ReadonlyMap<string, FXSlotValue>,
): Map<string, FXSlotValue> {
  const shadowOnly = new Set(
    target.outputs.filter((output) => output.shadowOnly === true).map((output) => output.slot),
  );
  return new Map([...slots].filter(([slot]) => !shadowOnly.has(slot)));
}

/** One output of a target's shadow program: the components it reads of a local of the graph. */
export interface FXShadowRoot {
  readonly slot: string;
  /** The stage of the color slot it comes from. */
  readonly stage: FXShaderStage;
  /** The local that slot reads. */
  readonly name: string;
  readonly channels: readonly number[];
}

/**
 * The outputs of `target`'s shadow program over a graph whose color program's slots are `slots`
 * and whose locals have the types `typeOf`: each the components it names of the color slot it
 * comes from (see `FXTarget.shadow`). A shadow output whose slot is unbound is unbound; undefined
 * for a target with no shadow.
 */
export function shadowRoots(
  target: FXTarget,
  slots: ReadonlyMap<string, FXSlotValue>,
  typeOf: ReadonlyMap<string, FXValueType>,
): FXShadowRoot[] | undefined {
  if (target.shadow === undefined) {
    return undefined;
  }
  const declared = new Map(target.outputs.map((output) => [output.slot, output.type]));
  // Unbound, or bound to a value not of its type (one only a width the compiler cannot adapt
  // reaches, which the color program cannot draw either): unbound here too.
  const sources = target.shadow.flatMap((output) => {
    const source = slots.get(output.from);
    const type = source === undefined ? undefined : typeOf.get(source.value);
    return source === undefined || type === undefined || type.id !== declared.get(output.from)?.id
      ? []
      : [{ output, source, type }];
  });
  const bound = new Set(sources.map(({ output }) => output.slot));
  return sources.flatMap(({ output, source, type }) => {
    if (output.unless !== undefined && bound.has(output.unless)) {
      return [];
    }
    const channels =
      output.channels === undefined
        ? Array.from({ length: type.components }, (_, index) => index)
        : componentIndices(output.channels);
    return [{ slot: output.slot, stage: source.stage, name: source.value, channels }];
  });
}

/** What {@link finalizeRenderPrograms} needs of the GLSL tier compiling a graph: its locals and
 *  uniforms so far, and how it names, carries and prints. */
export interface FXRenderTierFinish<L extends FXTypedLocal> {
  readonly tier: FXGLSLRenderTier;
  readonly vertex: readonly L[];
  readonly fragment: readonly L[];
  readonly uniforms: FXRenderUniforms;
  /** The varyings the graph's nodes allocated themselves - every program carries them. */
  readonly nodeVaryings: readonly FXVarying[];
  uniqueName(): string;
  /** Whether a value crossing between the stages rides a `flat` varying. */
  isFlat(local: L, perPrimitive: boolean): boolean;
  /** `locals` as a stage's body, reading each local in `carried` through its varying. */
  printStage(locals: readonly L[], carried: ReadonlyMap<string, string>): FXPrintedStage;
}

/**
 * A graph's compiled programs - its color program over `slots`, and the target's shadow program
 * cut down from it (see `shadowRoots`) - placed (see `placeRenderStages`) and printed by the tier.
 * Each vertex value a program's fragment stage reads crosses through one varying of that program.
 */
export function finalizeRenderPrograms<L extends FXTypedLocal>(
  target: FXTarget,
  slots: ReadonlyMap<string, FXSlotValue>,
  capabilities: FXRenderCapabilities,
  hash: string,
  tier: FXRenderTierFinish<L>,
): FXCompiledShader {
  const color = colorSlots(target, slots);
  const placement = placeRenderStages(
    {
      vertex: tier.vertex,
      fragment: tier.fragment,
      slots: color,
      shadow: shadowRoots(
        target,
        slots,
        new Map([...tier.vertex, ...tier.fragment].map((local) => [local.name, local.type])),
      ),
    },
    {
      target,
      tier: tier.tier,
      lightingIntrinsics: capabilities.lightingIntrinsics,
      uniforms: tier.uniforms.handles,
      projection: {
        nextName: () => tier.uniqueName(),
        derive: (local, name, type, expr) => ({ ...local, name, type, expr }),
      },
      isImpureCall: isImpureFunction,
      declareDrawUniform: (type) => tier.uniforms.allocate({ type, value: zeroValue(type) }).name,
    },
  );
  const finish = (
    placed: FXPlacedProgram<L>,
    programSlots: ReadonlyMap<string, FXSlotValue>,
  ): FXCompiledProgram => {
    const varyings = [...tier.nodeVaryings];
    const carried = new Map<string, string>();
    const writes: string[] = [];
    for (const { local, perPrimitive } of placed.crossing) {
      const name = tier.uniqueName();
      varyings.push({
        name,
        type: local.type,
        interpolation: tier.isFlat(local, perPrimitive) ? "flat" : "smooth",
      });
      carried.set(local.name, name);
      writes.push(`${name} = ${local.name};`);
    }
    const { vertex, fragment, outputs } = finishRenderStages(
      {
        vertex: tier.printStage(placed.vertex, new Map()),
        fragment: tier.printStage(placed.fragment, carried),
        varyingWrites: writes,
        carried,
        renamed: placement.renamed,
      },
      programSlots,
      tier.uniforms.handles,
    );
    return { varyings, vertex, fragment, outputs };
  };
  const colorProgram = finish(placement.color, color);
  const shadow =
    placement.shadow === undefined
      ? undefined
      : finish(placement.shadow.program, placement.shadow.slots);
  return {
    uniforms: tier.uniforms.record(),
    color: colorProgram,
    ...(shadow === undefined ? {} : { shadow }),
    capabilities,
    ...(placement.draw === undefined ? {} : { draw: placement.draw }),
    hash,
  };
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
