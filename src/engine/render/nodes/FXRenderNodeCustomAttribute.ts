import { FXRenderNode } from "../FXRenderNode";
import { FXShaderStage } from "../FXShaderStage";
import type { FXRenderContext } from "../compiler/FXRenderContext";
import type { FXSocketDescriptor } from "../../core/socket/FXSocket";
import type { FXValueType } from "../../core/socket/FXValueType";
import type { FXAttributeRequest } from "../../core/socket/FXAttribute";
import { attributeVaryingName } from "../target/FXParticleRenderTarget";
import type { FXNodeMeta } from "../../core/nodes/FXSocketSpec";
import { CUSTOM_ATTRIBUTE_META } from "../../nodes-std/manualNodeMetas";
import {
  checkAttributeStructuralParams,
  resolveAttributeSource,
} from "../../nodes-std/attributeSupport.Internal";
import { FXCompilerErrorException } from "../../core/compiler/FXCompilerError";

/**
 * Render node: reads a named per-particle attribute as its `value` output - a user attribute
 * rides `a_fx_<name>` into the `p_fx_<name>` varying, reserved through {@link attributeRequest}.
 * A core builtin (position/age/lifetime/id) reads through the separate `builtin-attribute`
 * node instead, never this one. Stage-flexible: both varyings are exposed in both stages, so
 * the compiler places this by its consumers (fragment tint vs. vertex billboard driver).
 */
export class FXRenderNodeCustomAttribute extends FXRenderNode {
  public readonly type = "custom-attribute";
  /** No intrinsic stage; the compiler infers placement from the consumers. The declared
   *  {@link stage} is only a nominal fallback. */
  public override readonly stageFlexible = true;
  public override readonly attributeRequest: FXAttributeRequest;
  public readonly inputs: readonly FXSocketDescriptor[] = [];
  public readonly outputs: readonly FXSocketDescriptor[];
  /** The declared attribute name this node reads. */
  private readonly sourceName: string;
  /** Target input this node reads: the attribute's `p_fx_<name>` varying. */
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
    // Rides from `a_fx_<name>` into the `p_fx_<name>` varying this reads.
    const source = resolveAttributeSource(name, type, attributeVaryingName);
    this.sourceName = source.sourceName;
    this.valueType = source.valueType;
    this.targetInput = source.targetInput;
    this.attributeRequest = source.attributeRequest;
    this.stageValue = stage;
    this.outputs = [{ key: "value", type: this.valueType }];
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
    return CUSTOM_ATTRIBUTE_META;
  }

  /** A varying/buffer read, no arithmetic. */
  public override estimateCost(): number {
    return 0;
  }

  /** `name`/`type` are structural - re-typing an attribute mints a fresh node id, so an in-place
   *  change is rejected. `stage` is inferred (not structural), so a snapshot value is tolerated
   *  and only checked for a legal spelling. */
  public override applyParams(params: Readonly<Record<string, unknown>>): void {
    checkAttributeStructuralParams(params, this.sourceName, this.valueType);
    const stage = params["stage"];
    if (stage !== undefined && stage !== FXShaderStage.VERTEX && stage !== FXShaderStage.FRAGMENT) {
      throw new FXCompilerErrorException({
        code: "bad-param-stage",
        message: `custom-attribute: "stage" must be "vertex" | "fragment"`,
        params: { context: "custom-attribute" },
      });
    }
  }

  public override cacheKey(): string {
    // `stage` is out of the key: it is inferred (stage-flexible), so it is folded into the
    // render hash via `stageTag`, not here - two reads of the same attribute share a key
    // regardless of where the compiler places them.
    return `${this.sourceName}:${this.valueType.id}`;
  }

  public build(ctx: FXRenderContext): void {
    ctx.setOutput("value", ctx.readTargetInput(this.targetInput));
  }
}
