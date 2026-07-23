import { FXRenderNode } from "../FXRenderNode";
import { FXShaderStage } from "../FXShaderStage";
import type { FXRenderContext } from "../compiler/FXRenderContext";
import type { FXUniformHandle } from "../compiler/FXCompiledShader";
import type { FXSocketDescriptor } from "../../core/socket/FXSocket";
import { FX_VALUE_TYPES } from "../../core/socket/FXValueType";
import { litVec, raw, ref } from "../../core/ir/FXExprBuilder";
import type { FXNodeMeta } from "../../core/nodes/FXSocketSpec";
import { TEXTURE_META } from "../../nodes-std/manualNodeMetas";
import { assertValidParamName, paramUniformName } from "../../nodes-std/paramSupport.Internal";

/** An unset (or empty) texture name is a valid, quiescent state (samples nothing => transparent),
 *  not an error; a present name still has to be a legal slot identifier. */
function resolveParameterName(name: unknown): string {
  // Undefined or null (serialized param data may carry either) means "no name set" - checked
  // via typeof rather than writing the banned null literal.
  const isNullish = name === undefined || (typeof name === "object" && !name);
  if (isNullish || name === "") {
    return "";
  }
  assertValidParamName(name);
  return name;
}

const VEC2 = FX_VALUE_TYPES.vec2;
const VEC4 = FX_VALUE_TYPES.vec4;
const SAMPLER2D = FX_VALUE_TYPES.sampler2D;

/** Render node (fragment): samples an external sampler at `uv` (defaulting to `p_uv`) into an
 *  rgba color. Owns no `three` resource: declares an external uniform under a stable slot that
 *  the host binds by name via `FXEmitter.fromArtifacts({ textures })` / `applyValues`. */
export class FXRenderNodeTexture extends FXRenderNode {
  public readonly type = "texture";
  public readonly stage = FXShaderStage.FRAGMENT;
  public readonly inputs: readonly FXSocketDescriptor[] = [{ key: "uv", type: VEC2 }];
  public readonly outputs: readonly FXSocketDescriptor[] = [{ key: "color", type: VEC4 }];

  private parameterName: string;
  private handle?: FXUniformHandle;

  constructor(name: unknown) {
    super();
    this.parameterName = resolveParameterName(name);
  }

  public override get targetReads(): readonly string[] {
    return ["p_uv"];
  }

  public static describe(): FXNodeMeta {
    return TEXTURE_META;
  }

  /** A hardware texture fetch (pricier than a plain ALU op); 0 while no texture is picked yet
   *  (a bare literal, see {@link build}). */
  public override estimateCost(): number {
    return this.parameterName === "" ? 0 : 8;
  }

  public override applyParams(params: Readonly<Record<string, unknown>>): void {
    const name = params["name"];
    if (name !== undefined) {
      this.parameterName = resolveParameterName(name);
    }
  }

  public override cacheKey(): string {
    return this.parameterName;
  }

  public build(ctx: FXRenderContext): void {
    // No texture picked yet: sample nothing and emit transparent black. The node stays a valid,
    // buildable node (allocating no sampler slot) until the user chooses a texture.
    if (this.parameterName === "") {
      ctx.setOutput("color", litVec(0, 0, 0, 0));
      return;
    }
    const uv = ctx.readInput("uv", ctx.readTargetInput("p_uv"));
    // An external sampler: declared under the stable slot, no baked value - the host binds it.
    this.handle = ctx.allocateUniform({
      type: SAMPLER2D,
      value: undefined,
      name: paramUniformName(this.parameterName),
      external: true,
    });
    ctx.setOutput(
      "color",
      raw(VEC4, "glsl", "texture2D($0, $1)", ref("uniform", this.handle.name, SAMPLER2D), uv),
    );
  }
}
