import { FXBehaviorNode } from "../FXBehaviorNode";
import { FXBehaviorPhase } from "../FXBehaviorPhase";
import type { FXKernelContext } from "../FXKernelContext";
import type { FXSocketDescriptor } from "../../core/socket/FXSocket";
import type { FXValueType } from "../../core/socket/FXValueType";
import { FX_VALUE_TYPES } from "../../core/socket/FXValueType";
import type { FXAttributeRequest } from "../../core/socket/FXAttribute";
import type { FXNodeMeta } from "../../core/nodes/FXSocketSpec";
import { BEHAVIOR_CUSTOM_ATTRIBUTE_SPLIT_META } from "../../nodes-std/manualNodeMetas";
import {
  checkAttributeStructuralParams,
  resolveAttributeSource,
} from "../../nodes-std/attributeSupport.Internal";
import { attributeInputName } from "../FXParticleBehaviorTarget";
import { FXCompilerErrorException } from "../../core/compiler/FXCompilerError";

/** Swizzle channel per output socket key, in declared order. */
const COMPONENTS = ["x", "y", "z", "w"] as const;

/**
 * Behavior node: reads a named per-particle attribute like
 * {@link FXBehaviorNodeCustomAttribute}, but fans it straight out to its float components
 * (`x`/`y`/`z`/`w` up to its width) instead of a single combined `value` - the fused equivalent
 * of `custom-attribute` piped into `split`, without an extra node or wire for the common
 * case of only needing one or two components.
 *
 * Phase-flexible: placed by its consumers, same as `custom-attribute`.
 */
export class FXBehaviorNodeCustomAttributeSplit extends FXBehaviorNode {
  public readonly type = "custom-attribute-split";
  public override readonly phaseFlexible = true;
  public override readonly attributeRequest: FXAttributeRequest;
  public readonly phase: FXBehaviorPhase;
  public readonly inputs: readonly FXSocketDescriptor[];
  /** Always all four `x`/`y`/`z`/`w` float sockets, regardless of the source's width - mirrors
   *  `split`'s own static descriptor; the editor facade trims the unused tail for display (see
   *  `domain/nodeFamilies.ts`'s `custom-attribute-split` family). */
  public readonly outputs: readonly FXSocketDescriptor[];
  private readonly sourceName: string;
  private readonly targetInput: string;
  private readonly valueType: FXValueType;

  /**
   * @param name - A user-declared attribute name (checked by {@link resolveAttributeSource})
   * @param type - Element type of the attribute
   * @param phase - Nominal fallback phase; the effective phase is inferred (see
   *   {@link phaseFlexible}). Defaults to UPDATE (a per-frame read of a persisted value).
   */
  constructor(name: string, type: FXValueType, phase: FXBehaviorPhase = FXBehaviorPhase.UPDATE) {
    super();
    const source = resolveAttributeSource(name, type, attributeInputName);
    this.sourceName = source.sourceName;
    this.valueType = source.valueType;
    this.targetInput = source.targetInput;
    this.attributeRequest = source.attributeRequest;
    this.phase = phase;
    this.inputs = [];
    this.outputs = COMPONENTS.map((key) => ({ key, type: FX_VALUE_TYPES.float }));
  }

  /** Palette metadata (category `attribute`; reads a named attribute, writes nothing). */
  public static describe(): FXNodeMeta {
    return BEHAVIOR_CUSTOM_ATTRIBUTE_SPLIT_META;
  }

  /** A buffer read plus a re-index (no arithmetic), like `custom-attribute` and `split`. */
  public override estimateCost(): number {
    return 0;
  }

  public override applyParams(params: Readonly<Record<string, unknown>>): void {
    checkAttributeStructuralParams(params, this.sourceName, this.valueType);
    const phase = params["phase"];
    if (
      phase !== undefined &&
      phase !== FXBehaviorPhase.SPAWN &&
      phase !== FXBehaviorPhase.UPDATE
    ) {
      throw new FXCompilerErrorException({
        code: "bad-param-phase",
        message: `custom-attribute-split: "phase" must be "spawn" | "update"`,
        params: { context: "custom-attribute-split" },
      });
    }
  }

  public override cacheKey(): string {
    return `${this.sourceName}:${this.valueType.id}`;
  }

  public build(ctx: FXKernelContext): void {
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
