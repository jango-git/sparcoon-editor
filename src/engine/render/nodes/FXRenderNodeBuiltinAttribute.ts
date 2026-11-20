import type { FXNodeMeta } from "../../core/nodes/FXSocketSpec";
import { FX_READABLE_CORE_BUILTINS } from "../../core/socket/FXReadableBuiltins";
import type { FXSocketDescriptor } from "../../core/socket/FXSocket";
import { BUILTIN_ATTRIBUTE_META } from "../../nodes-std/manualNodeMetas";
import type { FXRenderContext } from "../compiler/FXRenderContext";
import { FXRenderNode } from "../FXRenderNode";
import { FXShaderStage } from "../FXShaderStage";

/**
 * Reads position, age, lifetime and id from the `PARTICLE_*` inputs, one socket each. No
 * `attributeRequest`, no params. Stage-flexible.
 */
export class FXRenderNodeBuiltinAttribute extends FXRenderNode {
  public readonly type = "builtin-attribute";
  public override readonly stageFlexible = true;
  public readonly stage: FXShaderStage = FXShaderStage.FRAGMENT;
  public readonly inputs: readonly FXSocketDescriptor[] = [];
  public readonly outputs: readonly FXSocketDescriptor[] = Object.entries(
    FX_READABLE_CORE_BUILTINS,
  ).map(([name, builtin]) => ({ key: name, type: builtin.type }));

  public override get targetReads(): readonly string[] {
    return Object.values(FX_READABLE_CORE_BUILTINS).map((builtin) => builtin.targetInput);
  }

  public static describe(): FXNodeMeta {
    return BUILTIN_ATTRIBUTE_META;
  }

  public override estimateCost(): number {
    return 0;
  }

  public build(ctx: FXRenderContext): void {
    for (const [name, builtin] of Object.entries(FX_READABLE_CORE_BUILTINS)) {
      ctx.setOutput(name, ctx.readTargetInput(builtin.targetInput));
    }
  }
}
