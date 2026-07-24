import { FXCompilerErrorException } from "../../core/compiler/FXCompilerError";
import type { FXNodeRegistry } from "../../core/live/FXNodeRegistry";
import type { FXGLSLTypeName } from "../../core/socket/FXValueType";
import { resolveValueType } from "../../core/socket/FXValueType";
import type { FXRenderNode } from "../FXRenderNode";
import { FXShaderStage } from "../FXShaderStage";
import { resolveParamType } from "../../nodes-std/paramSupport.Internal";
import { FXRenderNodeCustomAttribute } from "./FXRenderNodeCustomAttribute";
import { FXRenderNodeCustomAttributeSplit } from "./FXRenderNodeCustomAttributeSplit";
import { FXRenderNodeBuiltinAttribute } from "./FXRenderNodeBuiltinAttribute";
import { FXRenderNodeTimelineValue } from "./FXRenderNodeTimelineValue";
import { FXRenderNodeTexture } from "./FXRenderNodeTexture";

function attributeType(
  params: Readonly<Record<string, unknown>> | undefined,
): ReturnType<typeof resolveValueType> {
  return resolveValueType((params?.["type"] as FXGLSLTypeName | undefined) ?? "vec4");
}

/** Registers the hand-written render manual nodes into `registry`. None owns a `three` texture
 *  resource directly, so all register unconditionally, needing no resolver. */
export function registerManualRenderNodes(registry: FXNodeRegistry<FXRenderNode>): void {
  registry.register(
    "custom-attribute",
    (params) =>
      new FXRenderNodeCustomAttribute(
        params?.["name"] as string,
        attributeType(params),
        coerceStage(params?.["stage"]),
      ),
  );

  registry.register(
    "custom-attribute-split",
    (params) =>
      new FXRenderNodeCustomAttributeSplit(
        params?.["name"] as string,
        attributeType(params),
        coerceStage(params?.["stage"]),
      ),
  );

  registry.register("builtin-attribute", () => new FXRenderNodeBuiltinAttribute());

  registry.register(
    "timeline-value",
    (params) =>
      new FXRenderNodeTimelineValue(
        params?.["name"] as string,
        resolveParamType(params?.["type"] ?? "float"),
        (params?.["value"] as number | readonly number[] | undefined) ?? 0,
      ),
  );
  registry.register("texture", (params) => new FXRenderNodeTexture(params?.["name"]));
}

/** Whitelists the `custom-attribute`(-components) stage param, rejecting a malformed value
 *  loudly rather than silently coercing anything non-`"vertex"` to fragment. */
function coerceStage(stage: unknown): FXShaderStage {
  if (stage === undefined || stage === "fragment") {
    return FXShaderStage.FRAGMENT;
  }
  if (stage === "vertex") {
    return FXShaderStage.VERTEX;
  }
  throw new FXCompilerErrorException({
    code: "bad-param-stage",
    message: `custom-attribute: "stage" must be "vertex" | "fragment"`,
    params: { context: "custom-attribute" },
  });
}
