import { FXCompilerErrorException } from "../../core/compiler/FXCompilerError";
import type { FXNodeRegistry } from "../../core/live/FXNodeRegistry";
import type { FXGLSLTypeName } from "../../core/socket/FXValueType";
import { resolveValueType } from "../../core/socket/FXValueType";
import type { FXRenderNode } from "../FXRenderNode";
import { FXShaderStage } from "../FXShaderStage";
import { resolveParamType } from "../../nodes-std/paramSupport.Internal";
import { FXRenderNodeReadAttribute } from "./FXRenderNodeReadAttribute";
import { FXRenderNodeReadAttributeComponents } from "./FXRenderNodeReadAttributeComponents";
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
    "read-attribute",
    (params) =>
      new FXRenderNodeReadAttribute(
        params?.["name"] as string,
        attributeType(params),
        coerceStage(params?.["stage"]),
      ),
  );

  registry.register(
    "read-attribute-components",
    (params) =>
      new FXRenderNodeReadAttributeComponents(
        params?.["name"] as string,
        attributeType(params),
        coerceStage(params?.["stage"]),
      ),
  );

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

/** Whitelists the `read-attribute` stage param, rejecting a malformed value loudly rather than
 *  silently coercing anything non-`"vertex"` to fragment. */
function coerceStage(stage: unknown): FXShaderStage {
  if (stage === undefined || stage === "fragment") {
    return FXShaderStage.FRAGMENT;
  }
  if (stage === "vertex") {
    return FXShaderStage.VERTEX;
  }
  throw new FXCompilerErrorException({
    code: "bad-param-stage",
    message: `read-attribute: "stage" must be "vertex" | "fragment"`,
    params: { context: "read-attribute" },
  });
}
