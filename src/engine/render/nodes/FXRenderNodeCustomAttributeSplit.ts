import { FXRenderNode } from "../FXRenderNode";
import { FXShaderStage } from "../FXShaderStage";
import type { FXRenderContext } from "../compiler/FXRenderContext";
import type { FXSocketDescriptor } from "../../core/socket/FXSocket";
import type { FXValueType } from "../../core/socket/FXValueType";
import { FX_VALUE_TYPES } from "../../core/socket/FXValueType";
import type { FXAttributeRequest } from "../../core/socket/FXAttribute";
import { attributeVaryingName } from "../target/FXParticleRenderTarget";
import type { FXNodeMeta } from "../../core/nodes/FXSocketSpec";
import { CUSTOM_ATTRIBUTE_SPLIT_META } from "../../nodes-std/manualNodeMetas";
import {
  checkAttributeStructuralParams,
  resolveAttributeSource,
} from "../../nodes-std/attributeSupport.Internal";
import { FXCompilerErrorException } from "../../core/compiler/FXCompilerError";

/** Swizzle channel per output socket key, in declared order. */
const COMPONENTS = ["x", "y", "z", "w"] as const;

/**
 * Render node: reads a named per-particle attribute like {@link FXRenderNodeCustomAttribute}, but
 * fans it straight out to its float components (`x`/`y`/`z`/`w` up to its width) instead of a
 * single combined `value` - the fused equivalent of `custom-attribute` piped into `split`,
 * without an extra node or wire for the common case of only needing one or two components. A
 * user attribute rides `a_fx_<name>` into the `p_fx_<name>` varying. Stage-flexible: both
 * varyings are exposed in both stages, so the compiler places this by its consumers.
 */
export class FXRenderNodeCustomAttributeSplit extends FXRenderNode {
  public readonly type = "custom-attribute-split";
  public override readonly stageFlexible = true;
  public override readonly attributeRequest: FXAttributeRequest;
  public readonly inputs: readonly FXSocketDescriptor[] = [];
  /** Always all four `x`/`y`/`z`/`w` float sockets, regardless of the source's width - mirrors
   *  `split`'s own static descriptor; the editor facade trims the unused tail for display (see
   *  `domain/nodeFamilies.ts`'s `custom-attribute-split` family). */
  public readonly outputs: readonly FXSocketDescriptor[];
  private readonly sourceName: string;
  private readonly targetInput: string;
  private readonly valueType: FXValueType;

  private readonly stageValue: FXShaderStage;

  /**
   * @param name - A user-declared attribute name (checked by {@link resolveAttributeSource})
   * @param type - Element type of the attribute
   * @param stage - Nominal fallback stage; the effective stage is inferred (see
   *   {@link stageFlexible}). Defaults to FRAGMENT.
   */
  constructor(name: string, type: FXValueType, stage: FXShaderStage = FXShaderStage.FRAGMENT) {
    super();
    const source = resolveAttributeSource(name, type, attributeVaryingName);
    this.sourceName = source.sourceName;
    this.valueType = source.valueType;
    this.targetInput = source.targetInput;
    this.attributeRequest = source.attributeRequest;
    this.stageValue = stage;
    this.outputs = COMPONENTS.map((key) => ({ key, type: FX_VALUE_TYPES.float }));
  }

  /** Nominal fallback stage; the effective stage is inferred by the compiler (see {@link stageFlexible}). */
  public get stage(): FXShaderStage {
    return this.stageValue;
  }

  public override get targetReads(): readonly string[] {
    return [this.targetInput];
  }

  /** Palette metadata (the read set is `dynamic` - it depends on the attribute name). */
  public static describe(): FXNodeMeta {
    return CUSTOM_ATTRIBUTE_SPLIT_META;
  }

  /** A varying/buffer read plus a re-index, no arithmetic. */
  public override estimateCost(): number {
    return 0;
  }

  public override applyParams(params: Readonly<Record<string, unknown>>): void {
    checkAttributeStructuralParams(params, this.sourceName, this.valueType);
    const stage = params["stage"];
    if (stage !== undefined && stage !== FXShaderStage.VERTEX && stage !== FXShaderStage.FRAGMENT) {
      throw new FXCompilerErrorException({
        code: "bad-param-stage",
        message: `custom-attribute-split: "stage" must be "vertex" | "fragment"`,
        params: { context: "custom-attribute-split" },
      });
    }
  }

  public override cacheKey(): string {
    return `${this.sourceName}:${this.valueType.id}`;
  }

  public build(ctx: FXRenderContext): void {
    const value = ctx.readTargetInput(this.targetInput);
    const componentCount = this.valueType.components;
    // A scalar source has no swizzle-able components; `x` is the value itself.
    if (componentCount === 1) {
      ctx.setOutput("x", value);
      return;
    }
    for (const channel of COMPONENTS.slice(0, componentCount)) {
      ctx.setOutput(channel, ctx.builders.swizzle(value, channel));
    }
  }
}
