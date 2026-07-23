import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import {
  registerStandardBehaviorNodes,
  registerStandardRenderNodes,
} from "../../src/engine/nodes-std/index";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";

/** A fresh registry preloaded with every standard behavior/shared node. */
export function behaviorRegistry(): FXNodeRegistry<FXBehaviorNode> {
  const registry = new FXNodeRegistry<FXBehaviorNode>();
  registerStandardBehaviorNodes(registry);
  return registry;
}

/** A fresh registry preloaded with every standard render/shared node. */
export function renderRegistry(): FXNodeRegistry<FXRenderNode> {
  const registry = new FXNodeRegistry<FXRenderNode>();
  registerStandardRenderNodes(registry);
  return registry;
}
