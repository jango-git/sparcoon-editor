import { FXCompilerErrorException } from "../../core/compiler/FXCompilerError";
import type { FXNodeMeta } from "../../core/nodes/FXSocketSpec";
import { checkStructuralParam } from "../../core/nodes/structuralParams.Internal";
import { assertValidAttributeName } from "../../core/socket/FXAttribute";
import type { FXSocketDescriptor } from "../../core/socket/FXSocket";
import type { FXGLSLTypeName, FXValueType } from "../../core/socket/FXValueType";
import { FX_VALUE_TYPES, NUMERIC_VALUE_TYPES } from "../../core/socket/FXValueType";
import { INHERITED_ATTRIBUTE_META } from "../../nodes-std/manualNodeMetas";
import { coerceParamValue } from "../../nodes-std/paramSupport.Internal";
import { FXBehaviorNode } from "../FXBehaviorNode";
import { FXBehaviorPhase } from "../FXBehaviorPhase";
import { FX_INHERIT_BUILTINS, inheritInputName } from "../FXInherit";
import type { FXInheritRequest, FXInheritSource } from "../FXInheritPlan";
import type { FXKernelContext } from "../FXKernelContext";

/**
 * Behavior node: what a newborn inherits from the particle whose death spawned it - a user
 * attribute of that particle, by name, or one of its core fields - as its `value` output. A birth
 * no death spawned (a timeline's, a host's) reads the node's default instead, as does one whose
 * dying particle has no such attribute. Spawn only: inheritance happens at birth.
 *
 * The source and type are structural (a new source is a new node, as for `custom-attribute`); the
 * default is applied in place, and reshapes the inherit layout (see {@link inheritInputName}).
 */
export class FXBehaviorNodeInheritedAttribute extends FXBehaviorNode {
  public readonly type = "inherited-attribute";
  public readonly phase = FXBehaviorPhase.SPAWN;
  public readonly inputs: readonly FXSocketDescriptor[] = [];
  public readonly outputs: readonly FXSocketDescriptor[];
  private readonly source: FXInheritSource;
  private readonly valueType: FXValueType;
  private defaults: readonly number[];

  /**
   * @param source - A user attribute (its name checked like a declaration's) or a core field,
   *   which is always a float.
   * @param type - Element type of a user attribute; ignored for a core field.
   * @param value - The default, a number or `type.components` numbers.
   */
  constructor(source: FXInheritSource, type: FXValueType, value: unknown) {
    super();
    if (source.kind === "attribute") {
      assertValidAttributeName(source.name, "inherited-attribute.name");
    } else if (!FX_INHERIT_BUILTINS.includes(source.field)) {
      throw new FXCompilerErrorException({
        code: "bad-structural-param-value",
        message: `param "name" must be one of ${FX_INHERIT_BUILTINS.join(", ")}; got ${JSON.stringify(source.field)}`,
        params: { key: "name", allowed: FX_INHERIT_BUILTINS.join(", "), got: source.field },
      });
    }
    this.source = source;
    this.valueType = source.kind === "builtin" ? FX_VALUE_TYPES.float : type;
    this.defaults = defaultsOf(this.valueType, value);
    this.outputs = [{ key: "value", type: this.valueType }];
  }

  public override get inheritRequest(): FXInheritRequest {
    return { source: this.source, type: this.valueType, defaults: this.defaults };
  }

  public override get targetReads(): readonly string[] {
    return [inheritInputName(this.inheritRequest)];
  }

  public static describe(): FXNodeMeta {
    return INHERITED_ATTRIBUTE_META;
  }

  public override resolveGenericHint(): FXGLSLTypeName {
    return this.valueType.id;
  }

  /** A value shared by the whole spawn call, no arithmetic. */
  public override estimateCost(): number {
    return 0;
  }

  /** `source`/`name`/`type` are structural; `value` (the default) applies in place. */
  public override applyParams(params: Readonly<Record<string, unknown>>): void {
    checkStructuralParam(params, "source", this.source.kind, ["attribute", "builtin"]);
    checkStructuralParam(
      params,
      "name",
      this.source.kind === "attribute" ? this.source.name : this.source.field,
    );
    if (this.source.kind === "attribute") {
      checkStructuralParam(params, "type", this.valueType.id, NUMERIC_VALUE_TYPES);
    }
    if ("value" in params) {
      this.defaults = defaultsOf(this.valueType, params["value"]);
    }
  }

  // The input names the source, type and default: a new default reads another value.
  public override cacheKey(): string {
    return inheritInputName(this.inheritRequest);
  }

  public build(ctx: FXKernelContext): void {
    ctx.setOutput("value", ctx.readTargetInput(inheritInputName(this.inheritRequest)));
  }
}

/** A default as the floats it lays out: `type.components` of them. */
function defaultsOf(type: FXValueType, value: unknown): readonly number[] {
  const coerced = coerceParamValue(type.components, value ?? 0);
  return typeof coerced === "number" ? [coerced] : coerced;
}
