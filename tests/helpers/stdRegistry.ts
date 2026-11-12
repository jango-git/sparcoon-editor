import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { registerManualBehaviorNodes } from "../../src/engine/behavior/nodes/FXManualBehaviorNodes";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import type { FXNodeDefinition } from "../../src/engine/core/nodes/defineNode";
import {
  registerStandardBehaviorNodes,
  registerStandardRenderNodes,
} from "../../src/engine/nodes-std/index";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { registerManualRenderNodes } from "../../src/engine/render/nodes/FXManualRenderNodes";

/** A fresh registry preloaded with every standard behavior/shared node, plus `testNodes`. */
export function behaviorRegistry(
  ...testNodes: readonly FXNodeDefinition[]
): FXNodeRegistry<FXBehaviorNode> {
  const registry = new FXNodeRegistry<FXBehaviorNode>();
  registerStandardBehaviorNodes(registry);
  for (const definition of testNodes) {
    registry.register(
      definition.type,
      (parameters) =>
        definition.createInstance("behavior", parameters) as unknown as FXBehaviorNode,
    );
  }
  return registry;
}

/** A fresh registry preloaded with every standard render/shared node. */
export function renderRegistry(): FXNodeRegistry<FXRenderNode> {
  const registry = new FXNodeRegistry<FXRenderNode>();
  registerStandardRenderNodes(registry);
  return registry;
}

/** {@link behaviorRegistry} plus the hand-written manual behavior nodes (attributes, timeline). */
export function fullBehaviorRegistry(): FXNodeRegistry<FXBehaviorNode> {
  const registry = behaviorRegistry();
  registerManualBehaviorNodes(registry);
  return registry;
}

/** {@link renderRegistry} plus the hand-written manual render nodes (attributes, timeline, texture). */
export function fullRenderRegistry(): FXNodeRegistry<FXRenderNode> {
  const registry = renderRegistry();
  registerManualRenderNodes(registry);
  return registry;
}
