import { FXCompilerErrorException } from "../../core/compiler/FXCompilerError";
import type { FXNodeMeta } from "../../core/nodes/FXSocketSpec";
import type { FXAttributeRequest } from "../../core/socket/FXAttribute";
import type { FXSocketDescriptor } from "../../core/socket/FXSocket";
import type { FXValueType } from "../../core/socket/FXValueType";
import {
  checkAttributeStructuralParams,
  resolveAttributeSource,
} from "../../nodes-std/attributeSupport.Internal";
import { CUSTOM_ATTRIBUTE_META } from "../../nodes-std/manualNodeMetas";
import type { FXRenderContext } from "../compiler/FXRenderContext";
import { FXRenderNode } from "../FXRenderNode";
import { FXShaderStage } from "../FXShaderStage";
import { attributeVaryingName } from "../target/FXParticleRenderTarget";

/**
 * Reads a user attribute through its `p_fx_<name>` varying, reserved by `attributeRequest`. A core
 * builtin uses `builtin-attribute`. Stage-flexible, so placement follows consumers.
 */
export class FXRenderNodeCustomAttribute extends FXRenderNode {
  public readonly type = "custom-attribute";
  public override readonly stageFlexible = true;
  public override readonly attributeRequest: FXAttributeRequest;
  public readonly inputs: readonly FXSocketDescriptor[] = [];
  public readonly outputs: readonly FXSocketDescriptor[];
  private readonly sourceName: string;
  /** Target input this node reads: the attribute's `p_fx_<name>` varying. */
  private readonly targetInput: string;
  private readonly valueType: FXValueType;

  private readonly stageValue: FXShaderStage;

  constructor(name: string, type: FXValueType, stage: FXShaderStage = FXShaderStage.FRAGMENT) {
    super();
    // The runtime fills the `p_fx_<name>` varying this reads from its packed attribute.
    const source = resolveAttributeSource(name, type, attributeVaryingName);
    this.sourceName = source.sourceName;
    this.valueType = source.valueType;
    this.targetInput = source.targetInput;
    this.attributeRequest = source.attributeRequest;
    this.stageValue = stage;
    this.outputs = [{ key: "value", type: this.valueType }];
  }

  public get stage(): FXShaderStage {
    return this.stageValue;
  }

  public override get targetReads(): readonly string[] {
    return [this.targetInput];
  }

  public static describe(): FXNodeMeta {
    return CUSTOM_ATTRIBUTE_META;
  }

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
