import { ref } from "../../core/ir/FXExprBuilder";
import type { FXNodeMeta } from "../../core/nodes/FXSocketSpec";
import type { FXSocketDescriptor } from "../../core/socket/FXSocket";
import type { FXGLSLTypeName, FXValueType } from "../../core/socket/FXValueType";
import { TIMELINE_VALUE_RENDER_META } from "../../nodes-std/manualNodeMetas";
import {
  coerceParamValue,
  FXTimelineValueState,
  PARAM_VALUE_TYPES,
  paramUniformName,
} from "../../nodes-std/paramSupport.Internal";
import type { FXUniformHandle } from "../compiler/FXCompiledShader";
import type { FXRenderContext } from "../compiler/FXRenderContext";
import { FXRenderNode } from "../FXRenderNode";
import { FXShaderStage } from "../FXShaderStage";

/**
 * A named uniform a timeline drives by name through `FXEmitter.applyValues`. Unlike `constant` it
 * takes a slot.
 */
export class FXRenderNodeTimelineValue extends FXRenderNode {
  public readonly type = "timeline-value";
  public readonly stage = FXShaderStage.FRAGMENT;
  public override readonly stageFlexible = true;
  public readonly inputs: readonly FXSocketDescriptor[] = [];
  public readonly outputs: readonly FXSocketDescriptor[] = [
    { key: "out", type: { generic: "T", constraint: PARAM_VALUE_TYPES } },
  ];

  private readonly parameter: FXTimelineValueState;
  private handle?: FXUniformHandle;

  constructor(name: string, type: FXValueType, value: number | readonly number[]) {
    super();
    this.parameter = new FXTimelineValueState(name, type, value);
  }

  public override get targetReads(): readonly string[] {
    return [];
  }

  /** Palette metadata (the read set is empty; the value is not a builtin read). */
  public static describe(): FXNodeMeta {
    return TIMELINE_VALUE_RENDER_META;
  }

  /** Resolves the generic `T` from the `type` param - no generic input to infer it from. */
  public override resolveGenericHint(): FXGLSLTypeName {
    return this.parameter.valueType.id;
  }

  public override estimateCost(): number {
    return 0;
  }

  public override applyParams(params: Readonly<Record<string, unknown>>): void {
    this.parameter.applyParams(params);
  }

  public override syncLiveValues(): void {
    if (this.handle === undefined) {
      return;
    }
    const value = coerceParamValue(
      this.parameter.valueType.components,
      this.parameter.currentValue,
    );
    this.handle.value = typeof value === "number" ? value : value.slice();
  }

  public override cacheKey(): string {
    return this.parameter.cacheKey();
  }

  public build(ctx: FXRenderContext): void {
    const resolvedType = ctx.resolvedType();
    const value = coerceParamValue(resolvedType.components, this.parameter.currentValue);
    this.handle = ctx.allocateUniform({
      type: resolvedType,
      value: typeof value === "number" ? value : value.slice(),
      name: paramUniformName(this.parameter.paramName),
    });
    ctx.setOutput("out", ref("uniform", this.handle.name, resolvedType));
  }
}
