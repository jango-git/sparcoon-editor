import { FXRenderNode } from "../FXRenderNode";
import { FXShaderStage } from "../FXShaderStage";
import type { FXRenderContext } from "../compiler/FXRenderContext";
import type { FXSocketDescriptor } from "../../core/socket/FXSocket";
import type { FXNodeMeta } from "../../core/nodes/FXSocketSpec";
import { BUILTIN_ATTRIBUTE_META } from "../../nodes-std/manualNodeMetas";
import { FX_READABLE_CORE_BUILTINS } from "../../core/socket/FXReadableBuiltins";

/**
 * Render node: reads all four host builtins (position/age/lifetime/id) at once, one output
 * socket each - the fixed-shape counterpart of `custom-attribute`'s by-name picker. Reads
 * the `PARTICLE_*` target inputs directly (no varying, no buffer), so it carries no
 * `attributeRequest` and takes no params - unlike a custom attribute, its shape never varies
 * per instance.
 *
 * Stage-flexible: every builtin is exposed in both stages, so placement is inferred from
 * consumers rather than fixed.
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

  /** Palette metadata (category `attribute`; reads all four builtins, writes nothing). */
  public static describe(): FXNodeMeta {
    return BUILTIN_ATTRIBUTE_META;
  }

  /** Four target-input reads, no arithmetic. */
  public override estimateCost(): number {
    return 0;
  }

  public build(ctx: FXRenderContext): void {
    for (const [name, builtin] of Object.entries(FX_READABLE_CORE_BUILTINS)) {
      ctx.setOutput(name, ctx.readTargetInput(builtin.targetInput));
    }
  }
}
