import { FXBehaviorNode } from "../FXBehaviorNode";
import { FXBehaviorPhase } from "../FXBehaviorPhase";
import type { FXKernelContext } from "../FXKernelContext";
import type { FXSocketDescriptor } from "../../core/socket/FXSocket";
import type { FXNodeMeta } from "../../core/nodes/FXSocketSpec";
import { BEHAVIOR_BUILTIN_ATTRIBUTE_META } from "../../nodes-std/manualNodeMetas";
import { FX_READABLE_CORE_BUILTINS } from "../../core/socket/FXReadableBuiltins";

/**
 * Behavior node: reads all four host builtins (position/age/lifetime/id) at once, one output
 * socket each - the fixed-shape counterpart of `custom-attribute`'s by-name picker. Reads
 * host state directly (no buffer reserved), so it carries no `attributeRequest` and takes no
 * params - unlike a custom attribute, its shape never varies per instance.
 *
 * Phase-flexible: every builtin is available in both spawn and update, so placement is inferred
 * from consumers rather than fixed.
 */
export class FXBehaviorNodeBuiltinAttribute extends FXBehaviorNode {
  public readonly type = "builtin-attribute";
  public override readonly phaseFlexible = true;
  public readonly phase: FXBehaviorPhase = FXBehaviorPhase.UPDATE;
  public readonly inputs: readonly FXSocketDescriptor[] = [];
  public readonly outputs: readonly FXSocketDescriptor[] = Object.entries(
    FX_READABLE_CORE_BUILTINS,
  ).map(([name, builtin]) => ({ key: name, type: builtin.type }));

  /** Palette metadata (category `attribute`; reads all four builtins, writes nothing). */
  public static describe(): FXNodeMeta {
    return BEHAVIOR_BUILTIN_ATTRIBUTE_META;
  }

  /** Four buffer-free reads, no arithmetic. */
  public override estimateCost(): number {
    return 0;
  }

  public build(ctx: FXKernelContext): void {
    for (const [name, builtin] of Object.entries(FX_READABLE_CORE_BUILTINS)) {
      ctx.setOutput(name, ctx.readTargetInput(builtin.targetInput));
    }
  }
}
