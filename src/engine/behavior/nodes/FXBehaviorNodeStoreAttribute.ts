import { FXBehaviorNode } from "../FXBehaviorNode";
import { FXBehaviorPhase } from "../FXBehaviorPhase";
import type { FXKernelContext } from "../FXKernelContext";
import type { FXSocketDescriptor } from "../../core/socket/FXSocket";
import type { FXValueType } from "../../core/socket/FXValueType";
import { NUMERIC_VALUE_TYPES } from "../../core/socket/FXValueType";
import type { FXAttributeRequest } from "../../core/socket/FXAttribute";
import { assertValidAttributeName } from "../../core/socket/FXAttribute";
import type { FXNodeMeta } from "../../core/nodes/FXSocketSpec";
import { checkStructuralParam } from "../../core/nodes/structuralParams.Internal";
import { STORE_ATTRIBUTE_META } from "../../nodes-std/manualNodeMetas";

/**
 * Behavior node: writes its `value` input into a named per-particle **attribute** buffer -
 * the writer half of the user-attribute channel (a render `read-attribute` reads the same
 * name on the GPU). Usually placed in SPAWN (a tint or seed chosen once at birth), but UPDATE
 * is legal too. `name`/`type` are structural, so they live in {@link cacheKey}.
 */
export class FXBehaviorNodeStoreAttribute extends FXBehaviorNode {
  public readonly type = "store-attribute";
  public override readonly attributeRequest: FXAttributeRequest;
  public readonly phase: FXBehaviorPhase;
  public readonly inputs: readonly FXSocketDescriptor[];
  public readonly outputs: readonly FXSocketDescriptor[];

  /**
   * @param name - Attribute name (`[a-z][a-zA-Z0-9]*`); the render side reads it by the same name
   * @param type - Element type (float/vec2/vec3/vec4)
   * @param phase - Phase to write in; defaults to SPAWN
   */
  constructor(name: string, type: FXValueType, phase: FXBehaviorPhase = FXBehaviorPhase.SPAWN) {
    super();
    assertValidAttributeName(name, "store-attribute.name");
    this.attributeRequest = { name, type };
    this.phase = phase;
    this.inputs = [{ key: "value", type, required: true }];
    this.outputs = [{ key: "value", type }];
  }

  /** Palette metadata (category `attribute`; writes only, reads nothing). */
  public static describe(): FXNodeMeta {
    return STORE_ATTRIBUTE_META;
  }

  /** A pass-through buffer write, no arithmetic. */
  public override estimateCost(): number {
    return 0;
  }

  /** All params (`name`/`type`/`phase`) are structural: none can be re-applied under a stable
   * id, so an in-place change is rejected as `bad-param` (audit-3 R5). */
  public override applyParams(params: Readonly<Record<string, unknown>>): void {
    checkStructuralParam(params, "name", this.attributeRequest.name);
    checkStructuralParam(params, "type", this.attributeRequest.type.id, NUMERIC_VALUE_TYPES);
    checkStructuralParam(params, "phase", this.phase, [
      FXBehaviorPhase.SPAWN,
      FXBehaviorPhase.UPDATE,
    ]);
  }

  public override cacheKey(): string {
    return `${this.attributeRequest.name}:${this.attributeRequest.type.id}:${this.phase}`;
  }

  public build(ctx: FXKernelContext): void {
    // Pass the input through; the graph binds this output to the `attr:<name>` slot.
    ctx.setOutput("value", ctx.readInput("value"));
  }
}
