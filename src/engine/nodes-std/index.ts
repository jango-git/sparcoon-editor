import type { FXNodeDefinition } from "../core/nodes/defineNode";
import type { FXNodeRegistry } from "../core/live/FXNodeRegistry";
import type { FXBehaviorNode } from "../behavior/FXBehaviorNode";
import type { FXRenderNode } from "../render/FXRenderNode";
import { FX_SHARED_MATH_NODES } from "./shared/math";
import { FX_BEHAVIOR_MATH_NODES } from "./behavior/math";
import { FX_BEHAVIOR_FORCE_NODES } from "./behavior/forces";
import { FX_BEHAVIOR_INTEGRATE_NODES } from "./behavior/integrate";
import { FX_BEHAVIOR_COLLISION_NODES } from "./behavior/collision";
import { FX_BEHAVIOR_SPAWN_NODES } from "./behavior/spawn";
import { FX_RENDER_SOURCE_NODES } from "./render/source";
import { FX_RENDER_CONTENT_NODES } from "./render/content";
import { FX_RENDER_EFFECT_NODES } from "./render/effects";
import { FX_RENDER_LIGHTING_NODES } from "./render/lighting";
import { FX_RENDER_MATRIX_NODES } from "./render/matrix";
import { FX_RENDER_TRANSFORM_NODES } from "./render/transform";

/**
 * The standard library of declarative node definitions (see {@link defineNode}). This is the
 * single source of truth an editor palette reads (`def.describe()`) and the reconciler builds
 * from (`registerStandard*Nodes`).
 */
export const FX_STANDARD_NODES: readonly FXNodeDefinition[] = [
  ...FX_SHARED_MATH_NODES,
  ...FX_BEHAVIOR_MATH_NODES,
  ...FX_BEHAVIOR_FORCE_NODES,
  ...FX_BEHAVIOR_INTEGRATE_NODES,
  ...FX_BEHAVIOR_COLLISION_NODES,
  ...FX_BEHAVIOR_SPAWN_NODES,
  ...FX_RENDER_SOURCE_NODES,
  ...FX_RENDER_CONTENT_NODES,
  ...FX_RENDER_EFFECT_NODES,
  ...FX_RENDER_LIGHTING_NODES,
  ...FX_RENDER_MATRIX_NODES,
  ...FX_RENDER_TRANSFORM_NODES,
];

/** Node definitions applicable to the behavior backend (`behavior` + `shared`). */
function behaviorDefinitions(): readonly FXNodeDefinition[] {
  return FX_STANDARD_NODES.filter(
    (definition) => definition.domain === "behavior" || definition.domain === "shared",
  );
}

/** Node definitions applicable to the render backend (`render` + `shared`). */
function renderDefinitions(): readonly FXNodeDefinition[] {
  return FX_STANDARD_NODES.filter(
    (definition) => definition.domain === "render" || definition.domain === "shared",
  );
}

/**
 * Registers every standard behavior/shared node into `registry`, wiring each type
 * string to a factory that rebuilds the live instance from serialized params.
 * Throws (via the registry) if a type is already registered.
 */
export function registerStandardBehaviorNodes(registry: FXNodeRegistry<FXBehaviorNode>): void {
  for (const definition of behaviorDefinitions()) {
    registry.register(
      definition.type,
      (parameters) =>
        definition.createInstance("behavior", parameters) as unknown as FXBehaviorNode,
    );
  }
}

/**
 * Registers every standard render/shared node into `registry`, wiring each type
 * string to a factory that rebuilds the live instance from serialized params.
 */
export function registerStandardRenderNodes(registry: FXNodeRegistry<FXRenderNode>): void {
  for (const definition of renderDefinitions()) {
    registry.register(
      definition.type,
      (parameters) => definition.createInstance("render", parameters) as unknown as FXRenderNode,
    );
  }
}

export { FX_SHARED_MATH_NODES } from "./shared/math";
export { FX_BEHAVIOR_MATH_NODES } from "./behavior/math";
export { FX_BEHAVIOR_FORCE_NODES } from "./behavior/forces";
export { FX_BEHAVIOR_INTEGRATE_NODES } from "./behavior/integrate";
export { FX_BEHAVIOR_COLLISION_NODES } from "./behavior/collision";
export { FX_BEHAVIOR_SPAWN_NODES } from "./behavior/spawn";
export { FX_RENDER_SOURCE_NODES } from "./render/source";
export { FX_RENDER_CONTENT_NODES } from "./render/content";
export { FX_RENDER_EFFECT_NODES } from "./render/effects";
export { FX_RENDER_LIGHTING_NODES } from "./render/lighting";
export { FX_RENDER_MATRIX_NODES } from "./render/matrix";
export { FX_RENDER_TRANSFORM_NODES } from "./render/transform";
