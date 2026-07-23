import { FXCompilerErrorException } from "../../core/compiler/FXCompilerError";
import type { FXNodeRegistry } from "../../core/live/FXNodeRegistry";
import type { FXGLSLTypeName } from "../../core/socket/FXValueType";
import { resolveValueType } from "../../core/socket/FXValueType";
import type { FXBehaviorNode } from "../FXBehaviorNode";
import { FXBehaviorPhase } from "../FXBehaviorPhase";
import { resolveParamType } from "../../nodes-std/paramSupport.Internal";
import { FXBehaviorNodeStoreAttribute } from "./FXBehaviorNodeStoreAttribute";
import { FXBehaviorNodeReadAttribute } from "./FXBehaviorNodeReadAttribute";
import { FXBehaviorNodeReadAttributeComponents } from "./FXBehaviorNodeReadAttributeComponents";
import { FXBehaviorNodeTimelineValue } from "./FXBehaviorNodeTimelineValue";

/**
 * Registers the hand-written **behavior** manual nodes: `store-attribute`/`read-attribute`/
 * `read-attribute-components` (the user-attribute channel) and `timeline-value`. The attribute
 * nodes carry an `attributeRequest` (so they cannot be `defineNode` descriptors), but need no
 * `three` resource, so the factories rebuild straight from snapshot params - no resolver required.
 */
export function registerManualBehaviorNodes(registry: FXNodeRegistry<FXBehaviorNode>): void {
  registry.register(
    "store-attribute",
    (parameters) =>
      new FXBehaviorNodeStoreAttribute(
        parameters?.["name"] as string,
        resolveValueType((parameters?.["type"] as FXGLSLTypeName | undefined) ?? "vec4"),
        coercePhase(parameters?.["phase"], FXBehaviorPhase.SPAWN),
      ),
  );
  registry.register(
    "read-attribute",
    (parameters) =>
      new FXBehaviorNodeReadAttribute(
        parameters?.["name"] as string,
        resolveValueType((parameters?.["type"] as FXGLSLTypeName | undefined) ?? "vec4"),
        coercePhase(parameters?.["phase"], FXBehaviorPhase.UPDATE),
      ),
  );
  registry.register(
    "read-attribute-components",
    (parameters) =>
      new FXBehaviorNodeReadAttributeComponents(
        parameters?.["name"] as string,
        resolveValueType((parameters?.["type"] as FXGLSLTypeName | undefined) ?? "vec4"),
        coercePhase(parameters?.["phase"], FXBehaviorPhase.UPDATE),
      ),
  );
  // Timeline Value (behavior half): a named live binding - no resource, no resolver.
  registry.register(
    "timeline-value",
    (parameters) =>
      new FXBehaviorNodeTimelineValue(
        parameters?.["name"] as string,
        resolveParamType(parameters?.["type"] ?? "float"),
        (parameters?.["value"] as number | readonly number[] | undefined) ?? 0,
      ),
  );
}

/**
 * Whitelists a manual node's `phase` param, rejecting a malformed value loudly rather than
 * silently defaulting it to `fallback` - mirrors `coerceStage` in `FXManualRenderNodes.ts`.
 */
function coercePhase(phase: unknown, fallback: FXBehaviorPhase): FXBehaviorPhase {
  if (phase === undefined) {
    return fallback;
  }
  if (phase === FXBehaviorPhase.SPAWN || phase === FXBehaviorPhase.UPDATE) {
    return phase;
  }
  throw new FXCompilerErrorException({
    code: "bad-param-phase",
    message: `manual behavior node: "phase" must be "spawn" | "update"`,
    params: { context: "manual behavior node" },
  });
}
