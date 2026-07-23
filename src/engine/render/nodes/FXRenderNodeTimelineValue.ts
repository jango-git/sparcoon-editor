import { FXRenderNode } from "../FXRenderNode";
import { FXShaderStage } from "../FXShaderStage";
import type { FXRenderContext } from "../compiler/FXRenderContext";
import type { FXUniformHandle } from "../compiler/FXCompiledShader";
import type { FXSocketDescriptor } from "../../core/socket/FXSocket";
import type { FXGLSLTypeName, FXValueType } from "../../core/socket/FXValueType";
import { ref } from "../../core/ir/FXExprBuilder";
import type { FXNodeMeta } from "../../core/nodes/FXSocketSpec";
import { TIMELINE_VALUE_RENDER_META } from "../../nodes-std/manualNodeMetas";
import {
  FXTimelineValueState,
  PARAM_VALUE_TYPES,
  paramUniformName,
  coerceParamValue,
} from "../../nodes-std/paramSupport.Internal";

/** Render node: a named, runtime-tunable value exposed as a shader uniform. Unlike `constant`
 *  (which bakes an inline literal), this allocates a uniform under a stable slot derived from
 *  the user name, so a timeline can drive it by name through {@link FXEmitter.applyValues}. */
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

  /** Palette metadata (the read set is empty; the value is not a builtin read). */
  public static describe(): FXNodeMeta {
    return TIMELINE_VALUE_RENDER_META;
  }

  /** Resolves the generic `T` from the `type` param - no generic input to infer it from. */
  public override resolveGenericHint(): FXGLSLTypeName {
    return this.parameter.valueType.id;
  }

  /** A live uniform read, no arithmetic (like `constant`). */
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
