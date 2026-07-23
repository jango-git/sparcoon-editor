import { FXBehaviorNode } from "../FXBehaviorNode";
import { FXBehaviorPhase } from "../FXBehaviorPhase";
import type { FXKernelContext } from "../FXKernelContext";
import type { FXKernelBindingHandle } from "../FXCompiledKernel";
import type { FXSocketDescriptor } from "../../core/socket/FXSocket";
import type { FXGLSLTypeName, FXValueType } from "../../core/socket/FXValueType";
import { FX_VALUE_TYPES } from "../../core/socket/FXValueType";
import { construct, ref } from "../../core/ir/FXExprBuilder";
import type { FXNodeMeta } from "../../core/nodes/FXSocketSpec";
import { TIMELINE_VALUE_BEHAVIOR_META } from "../../nodes-std/manualNodeMetas";
import {
  FXTimelineValueState,
  PARAM_COMPONENTS,
  PARAM_VALUE_TYPES,
  paramBindingName,
  coerceParamValue,
} from "../../nodes-std/paramSupport.Internal";

const FLOAT = FX_VALUE_TYPES.float;

/**
 * Behavior node: a named, runtime-tunable **value** captured as a live kernel **binding** - the
 * behavior half of Timeline Value (the CPU analog of the render uniform). Binding names derive
 * from the stable user name, so a timeline drives it by name through {@link FXEmitter.applyValues}.
 * `name`/`type` are structural ({@link cacheKey}); the default `value` is live.
 */
export class FXBehaviorNodeTimelineValue extends FXBehaviorNode {
  public readonly type = "timeline-value";
  public readonly phase = FXBehaviorPhase.UPDATE;
  public override readonly phaseFlexible = true;
  public readonly inputs: readonly FXSocketDescriptor[] = [];
  public readonly outputs: readonly FXSocketDescriptor[] = [
    { key: "out", type: { generic: "T", constraint: PARAM_VALUE_TYPES } },
  ];

  private readonly parameter: FXTimelineValueState;
  private handles: readonly FXKernelBindingHandle[] = [];

  constructor(name: string, type: FXValueType, value: number | readonly number[]) {
    super();
    this.parameter = new FXTimelineValueState(name, type, value);
  }

  public static describe(): FXNodeMeta {
    return TIMELINE_VALUE_BEHAVIOR_META;
  }

  public override resolveGenericHint(): FXGLSLTypeName {
    return this.parameter.valueType.id;
  }

  /** A live binding read, no arithmetic (like `constant`). */
  public override estimateCost(): number {
    return 0;
  }

  public override applyParams(params: Readonly<Record<string, unknown>>): void {
    this.parameter.applyParams(params);
  }

  public override syncLiveValues(): void {
    const value = coerceParamValue(
      this.parameter.valueType.components,
      this.parameter.currentValue,
    );
    if (typeof value === "number") {
      if (this.handles[0] !== undefined) {
        this.handles[0].value = value;
      }
      return;
    }
    for (let i = 0; i < this.handles.length; i++) {
      const handle = this.handles[i];
      const component = value[i];
      if (handle === undefined || component === undefined) {
        throw new Error("Timeline value handle and component arrays are out of sync");
      }
      handle.value = component;
    }
  }

  public override cacheKey(): string {
    return this.parameter.cacheKey();
  }

  public build(ctx: FXKernelContext): void {
    const resolvedType = ctx.resolvedType();
    const base = paramBindingName(this.parameter.paramName);
    const value = coerceParamValue(resolvedType.components, this.parameter.currentValue);
    if (typeof value === "number") {
      const handle = ctx.allocateBinding({ value, name: base });
      this.handles = [handle];
      ctx.setOutput("out", ref("binding", handle.name, FLOAT));
      return;
    }
    const handles = value.map((component, i) =>
      ctx.allocateBinding({ value: component, name: `${base}_${PARAM_COMPONENTS[i]}` }),
    );
    this.handles = handles;
    ctx.setOutput(
      "out",
      construct(resolvedType, ...handles.map((handle) => ref("binding", handle.name, FLOAT))),
    );
  }
}
