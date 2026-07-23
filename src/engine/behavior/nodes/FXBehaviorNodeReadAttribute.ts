import { FXBehaviorNode } from "../FXBehaviorNode";
import { FXBehaviorPhase } from "../FXBehaviorPhase";
import type { FXKernelContext } from "../FXKernelContext";
import type { FXSocketDescriptor } from "../../core/socket/FXSocket";
import type { FXValueType } from "../../core/socket/FXValueType";
import type { FXAttributeRequest } from "../../core/socket/FXAttribute";
import type { FXNodeMeta } from "../../core/nodes/FXSocketSpec";
import { BEHAVIOR_READ_ATTRIBUTE_META } from "../../nodes-std/manualNodeMetas";
import {
  checkAttributeStructuralParams,
  resolveAttributeSource,
} from "../../nodes-std/attributeSupport.Internal";
import { attributeInputName } from "../FXParticleBehaviorTarget";
import { FXCompilerErrorException } from "../../core/compiler/FXCompilerError";

/**
 * Behavior node: reads a named per-particle **attribute** buffer as its `value` output - the
 * reader half of the user-attribute channel (the render `read-attribute` reads the same name
 * on the GPU). This is what lets an update node consume a value another node persisted:
 * `read-attribute(velocity)` -> `gravity` -> `store-attribute(velocity)` accumulates velocity
 * across frames.
 *
 * Phase-flexible: placed by its consumers, since unlike a render varying, spawn and update
 * never bridge - one node cannot feed both phases (a cross-phase error; use two reads).
 */
export class FXBehaviorNodeReadAttribute extends FXBehaviorNode {
  public readonly type = "read-attribute";
  /** No intrinsic phase: placement is inferred from consumers, symmetric to
   * {@link FXBehaviorNodeTimelineValue}. The declared {@link phase} is only a nominal fallback. */
  public override readonly phaseFlexible = true;
  /** Absent for a builtin read (host state, no buffer); present for a user attribute. */
  public override readonly attributeRequest?: FXAttributeRequest | undefined;
  public readonly phase: FXBehaviorPhase;
  public readonly inputs: readonly FXSocketDescriptor[];
  public readonly outputs: readonly FXSocketDescriptor[];
  /** The editor `name` (a builtin key like `position`, or a user attribute name). */
  private readonly sourceName: string;
  /** Target input this node reads: a builtin `PARTICLE_*`, or an attribute's `ATTR_<name>`. */
  private readonly targetInput: string;
  private readonly valueType: FXValueType;

  /**
   * @param name - A readable builtin (`position`/`age`/`lifetime`) or a user attribute name
   * @param type - Element type of a user attribute (ignored for a builtin, whose type is fixed)
   * @param phase - Nominal fallback phase; the effective phase is inferred (see
   *   {@link phaseFlexible}). Defaults to UPDATE (a per-frame read of a persisted value).
   */
  constructor(name: string, type: FXValueType, phase: FXBehaviorPhase = FXBehaviorPhase.UPDATE) {
    super();
    // A user attribute reserves its buffer and reads the `ATTR_<name>` kernel input.
    const source = resolveAttributeSource(name, type, attributeInputName);
    this.sourceName = source.sourceName;
    this.valueType = source.valueType;
    this.targetInput = source.targetInput;
    this.attributeRequest = source.attributeRequest;
    this.phase = phase;
    this.inputs = [];
    this.outputs = [{ key: "value", type: this.valueType }];
  }

  /** Palette metadata (category `attribute`; reads a named attribute, writes nothing). */
  public static describe(): FXNodeMeta {
    return BEHAVIOR_READ_ATTRIBUTE_META;
  }

  /** A buffer read, no arithmetic. */
  public override estimateCost(): number {
    return 0;
  }

  /**
   * `name`/`type` are structural - an in-place change is rejected as `bad-param`.
   * `phase` is inferred, so it is only checked for a legal spelling; a malformed value still
   * fails loudly.
   */
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
        message: `read-attribute: "phase" must be "spawn" | "update"`,
        params: { context: "read-attribute" },
      });
    }
  }

  public override cacheKey(): string {
    // `phase` is out of the key (folded into the hash via `phaseTag` instead): two reads of
    // the same attribute share a key regardless of where the compiler places them.
    return `${this.sourceName}:${this.valueType.id}`;
  }

  public build(ctx: FXKernelContext): void {
    ctx.setOutput("value", ctx.readTargetInput(this.targetInput));
  }
}
