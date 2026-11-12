import { fxExternalSampleFunction } from "sparcoon/editor";

import { FXCompilerErrorException } from "../../core/compiler/FXCompilerError";
import type { FXExpr } from "../../core/ir/FXExpr";
import { litVec, raw } from "../../core/ir/FXExprBuilder";
import type { FXNodeMeta } from "../../core/nodes/FXSocketSpec";
import type { FXSocketDescriptor } from "../../core/socket/FXSocket";
import { FX_VALUE_TYPES } from "../../core/socket/FXValueType";
import type { FXTextureWrapMode } from "../../nodes-std/manualNodeMetas";
import { TEXTURE_META, TEXTURE_WRAP_MODES } from "../../nodes-std/manualNodeMetas";
import { assertValidParamName, paramUniformName } from "../../nodes-std/paramSupport.Internal";
import type { FXUniformHandle } from "../compiler/FXCompiledShader";
import type { FXRenderContext } from "../compiler/FXRenderContext";
import { FXRenderNode } from "../FXRenderNode";
import { FXShaderStage } from "../FXShaderStage";

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

/** An absent wrap (a project saved before the param existed) is the hardware clamp it always had;
 *  a present one has to be a known mode. */
function resolveWrapMode(wrap: unknown): FXTextureWrapMode {
  if (wrap === undefined) {
    return "clamp";
  }
  if (typeof wrap !== "string" || !(TEXTURE_WRAP_MODES as readonly string[]).includes(wrap)) {
    const options = TEXTURE_WRAP_MODES.join(", ");
    throw new FXCompilerErrorException({
      code: "bad-enum-value",
      message: `texture: wrap expects one of [${options}]`,
      params: { where: "texture.wrap", options },
    });
  }
  return wrap as FXTextureWrapMode;
}

/** ALU ops each wrap mode adds on top of the fetch (see {@link FXRenderNodeTexture.build}):
 *  repeat = fract (2); mirror = mod, -1, abs, 1- (8); border = two vec2 steps, a multiply of
 *  them, the x*y product and the vec4 scale (2+2+2+1+4 = 11). */
const WRAP_COST: Readonly<Record<FXTextureWrapMode, number>> = {
  clamp: 0,
  repeat: 2,
  mirror: 8,
  border: 11,
};

const VEC2 = FX_VALUE_TYPES.vec2;
const VEC4 = FX_VALUE_TYPES.vec4;
const SAMPLER2D = FX_VALUE_TYPES.sampler2D;

/** Render node (fragment): samples an external sampler at `uv` (defaulting to `p_uv`) into an
 *  rgba color, through the runtime-defined `fxSample_<uniform>` (see `fxExternalSampleFunction`).
 *  Owns no `three` resource: declares an external uniform under a stable slot that the host binds
 *  by name via `FXEmitter.fromArtifacts({ textures })` / `applyValues`.
 *
 *  `wrap` is applied to `uv` in the shader, not on the sampler: the host owns the `Texture` (and
 *  its `wrapS`/`wrapT`) in an exported effect, so a sampler setting could never reach it. `clamp`
 *  leaves `uv` as is (the host texture's own clamp, or for an atlas region the runtime's clamp to
 *  the region); `repeat` tiles it with `fract`; `mirror` tiles it flipping every other tile;
 *  `border` samples as `clamp` but is transparent outside [0, 1]. Each mode thus tiles or masks a
 *  bound region, never the whole atlas. */
export class FXRenderNodeTexture extends FXRenderNode {
  public readonly type = "texture";
  public readonly stage = FXShaderStage.FRAGMENT;
  public readonly inputs: readonly FXSocketDescriptor[] = [{ key: "uv", type: VEC2 }];
  public readonly outputs: readonly FXSocketDescriptor[] = [{ key: "color", type: VEC4 }];

  private parameterName: string;
  private wrap: FXTextureWrapMode;
  private handle?: FXUniformHandle;

  constructor(name: unknown, wrap?: unknown) {
    super();
    this.parameterName = resolveParameterName(name);
    this.wrap = resolveWrapMode(wrap);
  }

  public override get targetReads(): readonly string[] {
    return ["p_uv"];
  }

  public static describe(): FXNodeMeta {
    return TEXTURE_META;
  }

  /** A hardware texture fetch (pricier than a plain ALU op) plus the wrap mode's UV math; 0 while
   *  no texture is picked yet (a bare literal, see {@link build}). */
  public override estimateCost(): number {
    return this.parameterName === "" ? 0 : 8 + WRAP_COST[this.wrap];
  }

  public override applyParams(params: Readonly<Record<string, unknown>>): void {
    const name = params["name"];
    if (name !== undefined) {
      this.parameterName = resolveParameterName(name);
    }
    // Absent resets to the default, like a defineNode structural param missing from a snapshot.
    this.wrap = resolveWrapMode(params["wrap"]);
  }

  public override cacheKey(): string {
    return `${this.parameterName}:${this.wrap}`;
  }

  public build(ctx: FXRenderContext): void {
    // No texture picked yet: sample nothing and emit transparent black. The node stays a valid,
    // buildable node (allocating no sampler slot) until the user chooses a texture.
    if (this.parameterName === "") {
      ctx.setOutput("color", litVec(0, 0, 0, 0));
      return;
    }
    const fn = ctx.builders;
    const uv = ctx.readInput("uv", ctx.readTargetInput("p_uv"));
    // An external sampler: declared under the stable slot, no baked value - the host binds it.
    // Sampled through the runtime's per-slot function, not `texture2D`: the host may bind a whole
    // `Texture` or a region of an atlas, and the runtime defines the function for what it got.
    this.handle = ctx.allocateUniform({
      type: SAMPLER2D,
      value: undefined,
      name: paramUniformName(this.parameterName),
      external: true,
    });
    const sampleFunction = fxExternalSampleFunction(this.handle.name);
    const sample = (at: FXExpr): FXExpr => raw(VEC4, "glsl", `${sampleFunction}($0)`, at);
    switch (this.wrap) {
      case "clamp":
        ctx.setOutput("color", sample(uv));
        return;
      case "repeat":
        ctx.setOutput("color", sample(fn.call("fract", uv)));
        return;
      case "mirror": {
        // 1 - |mod(uv, 2) - 1|: the identity on [0, 1], flipped on [1, 2], period 2.
        const one = fn.litVec(1, 1);
        const folded = fn.call("abs", fn.sub(fn.mod(uv, fn.litVec(2, 2)), one));
        ctx.setOutput("color", sample(fn.sub(one, folded)));
        return;
      }
      case "border": {
        // 1 inside [0, 1] on both axes, else 0 - scales the whole rgba, so outside is transparent.
        const inside = ctx.defineLocal(
          "tex_in",
          fn.mul(fn.call("step", fn.lit(0), uv), fn.call("step", uv, fn.litVec(1, 1))),
        );
        const mask = fn.mul(fn.swizzle(inside, "x"), fn.swizzle(inside, "y"));
        ctx.setOutput("color", fn.mul(sample(uv), mask));
        return;
      }
    }
  }
}
