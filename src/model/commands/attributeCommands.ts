import type { AttributeTypeName, EditorGraph } from "../../domain/graphModel";
import { isReservedAttributeName } from "../../domain/nodePalette";
import { attributeSlot } from "../../engine/behavior/FXParticleBehaviorTarget";
import { isValidAttributeName } from "../../engine/core/socket/FXAttribute";
import type { Store } from "../store";
import { nextIdentifier } from "./identifier";
import {
  activeGraph,
  activeOwnerHasBehaviorGraph,
  withGraph,
  type GraphSlot,
} from "./graphAccess.Internal";

/**
 * Every node type that reads a custom attribute by name (render/GPU + behavior/CPU twins, plus
 * the components-fanout variant) - all of them must be retargeted on a rename, or the one left
 * out orphans into an `undeclared-attribute` compile error under the old name.
 */
const CUSTOM_ATTRIBUTE_TYPES: ReadonlySet<string> = new Set([
  "custom-attribute",
  "custom-attribute-split",
]);

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
  const trimmed = name.trim();
  const graph = activeGraph(store.getSource(), slot);
  if (
    !isValidAttributeName(trimmed) ||
    isReservedAttributeName(trimmed) || // position/age/lifetime are builtin read sources
    graph.attributes.some((attribute) => attribute.name === trimmed)
  ) {
    return false;
  }
  const next = withGraph(store.getSource(), slot, (current) => ({
    ...current,
    attributes: [...current.attributes, { name: trimmed, type }],
  }));
  store.commit(next, "structural");
  return true;
}

/**
 * Renames a declared attribute: retargets its `attr:<name>` output-binding slot and re-mints
 * every custom-attribute node reading it - both {@link CUSTOM_ATTRIBUTE_TYPES}, in
 * both the behavior and render graphs (the attribute is a simulation->render channel) - under a
 * fresh id with the new name, all in one
 * commit. A fresh id is required, not cosmetic: {@link FXGraphReconciler} reuses a same-id
 * instance by calling its `applyParams`, which throws on a structural param like `name` -
 * re-minting is how every other structural edit in this codebase (e.g. `replaceNodeParams`)
 * avoids that throw. Returns `false` for an invalid/duplicate new name or an undeclared
 * `oldName` - a no-op the caller surfaces; renaming to the same name is a no-op success.
 */
export function renameAttribute(
  store: Store,
  slot: GraphSlot,
  oldName: string,
  newName: string,
): boolean {
  if (!activeOwnerHasBehaviorGraph(store.getSource())) {
    return false;
  }
  const trimmed = newName.trim();
  if (trimmed === oldName) {
    return true;
  }
  const graph = activeGraph(store.getSource(), slot);
  if (
    !graph.attributes.some((attribute) => attribute.name === oldName) ||
    !isValidAttributeName(trimmed) ||
    isReservedAttributeName(trimmed) ||
    graph.attributes.some((attribute) => attribute.name === trimmed)
  ) {
    return false;
  }
  const oldSlot = attributeSlot(oldName);
  const newSlot = attributeSlot(trimmed);
  const renamed = withGraph(store.getSource(), slot, (current) => ({
    ...current,
    attributes: current.attributes.map((attribute) =>
      attribute.name === oldName ? { ...attribute, name: trimmed } : attribute,
    ),
    outputBindings: current.outputBindings.map((binding) =>
      binding.slot === oldSlot ? { ...binding, slot: newSlot } : binding,
    ),
  }));
  const next = (["behaviorGraph", "renderGraph"] as const).reduce(
    (source, graphSlot) =>
      withGraph(source, graphSlot, (current) =>
        retargetCustomAttributeNodes(current, oldName, trimmed),
      ),
    renamed,
  );
  store.commit(next, "structural");
  return true;
}

/** Re-mints every custom-attribute node named `oldName` with `newName`, remapping its wires. */
function retargetCustomAttributeNodes(
  graph: EditorGraph,
  oldName: string,
  newName: string,
): EditorGraph {
  const matches = Object.values(graph.nodes).filter(
    (node) => CUSTOM_ATTRIBUTE_TYPES.has(node.type) && node.parameters["name"] === oldName,
  );
  if (matches.length === 0) {
    return graph;
  }
  const nodes = { ...graph.nodes };
  let connections = graph.connections;
  let outputBindings = graph.outputBindings;
  for (const node of matches) {
    const newId = nextIdentifier("node");
    delete nodes[node.id];
    nodes[newId] = { ...node, id: newId, parameters: { ...node.parameters, name: newName } };
    const remapRef = <T extends { nodeId: string }>(ref: T): T =>
      ref.nodeId === node.id ? { ...ref, nodeId: newId } : ref;
    connections = connections.map((connection) => ({
      ...connection,
      from: remapRef(connection.from),
      to: remapRef(connection.to),
    }));
    outputBindings = outputBindings.map((binding) => ({
      ...binding,
      from: remapRef(binding.from),
    }));
  }
  return { ...graph, nodes, connections, outputBindings };
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
