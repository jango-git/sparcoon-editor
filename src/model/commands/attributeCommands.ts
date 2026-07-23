import type { AttributeTypeName } from "../../domain/graphModel";
import { isReservedAttributeName } from "../../domain/nodePalette";
import { attributeSlot } from "../../engine/behavior/FXParticleBehaviorTarget";
import { isValidAttributeName } from "../../engine/core/socket/FXAttribute";
import type { Store } from "../store";
import {
  activeGraph,
  activeOwnerHasBehaviorGraph,
  withGraph,
  type GraphSlot,
} from "./graphAccess.Internal";

/**
 * Declares a user attribute (its `attr:<name>` slot appears on both phase sinks). Returns `false`
 * for an invalid/duplicate name (the engine's attribute-name grammar) - a no-op the caller surfaces.
 */
export function addAttribute(
  store: Store,
  slot: GraphSlot,
  name: string,
  type: AttributeTypeName,
): boolean {
  // Attributes are a simulation->render channel a render-only VFX mesh has no runtime for, so
  // declaring one is meaningless while a mesh owns the graph - reject it honestly, not silently.
  if (!activeOwnerHasBehaviorGraph(store.getSource())) {
    return false;
  }
  // The grammar requires a lowercase first letter (it becomes a GLSL/JS identifier), so a
  // capitalized entry like "Velocity" is normalized to "velocity" rather than rejected.
  const trimmed = name.trim();
  const normalized = trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
  const graph = activeGraph(store.getSource(), slot);
  if (
    !isValidAttributeName(normalized) ||
    isReservedAttributeName(normalized) || // position/age/lifetime are builtin read sources
    graph.attributes.some((attribute) => attribute.name === normalized)
  ) {
    return false;
  }
  const next = withGraph(store.getSource(), slot, (current) => ({
    ...current,
    attributes: [...current.attributes, { name: normalized, type }],
  }));
  store.commit(next, "structural");
  return true;
}

/** Removes a declared attribute and any output binding that wrote its slot. */
export function removeAttribute(store: Store, slot: GraphSlot, name: string): void {
  if (!activeOwnerHasBehaviorGraph(store.getSource())) {
    return;
  }
  const removedSlot = attributeSlot(name);
  const next = withGraph(store.getSource(), slot, (graph) => ({
    ...graph,
    attributes: graph.attributes.filter((attribute) => attribute.name !== name),
    outputBindings: graph.outputBindings.filter((binding) => binding.slot !== removedSlot),
  }));
  store.commit(next, "structural");
}

/** Changes a declared attribute's element type (a structural edit - recompiles). */
export function setAttributeType(
  store: Store,
  slot: GraphSlot,
  name: string,
  type: AttributeTypeName,
): void {
  if (!activeOwnerHasBehaviorGraph(store.getSource())) {
    return;
  }
  const next = withGraph(store.getSource(), slot, (graph) => ({
    ...graph,
    attributes: graph.attributes.map((attribute) =>
      attribute.name === name ? { ...attribute, type } : attribute,
    ),
  }));
  store.commit(next, "structural");
}
