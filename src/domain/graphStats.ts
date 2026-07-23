/**
 * Node count + total complexity of the authored graph, for the editor's Stats readout. Mints
 * throwaway engine node instances and delegates to the engine's `collectGraphStats` for the answer.
 */

import { FXGraph } from "../engine/core/FXGraph";
import type { FXGraphNode } from "../engine/core/FXGraphNode";
import { FXNodeRegistry } from "../engine/core/live/FXNodeRegistry";
import type { FXGraphSnapshotData } from "../engine/core/live/FXSnapshotData";
import type { FXValueTypeId } from "../engine/core/socket/FXValueType";
import { FX_VALUE_TYPES } from "../engine/core/socket/FXValueType";
import { collectGraphStats, type FXGraphStats } from "../engine/core/compiler/collectGraphStats";
import {
  registerStandardBehaviorNodes,
  registerStandardRenderNodes,
} from "../engine/nodes-std/index";
import { registerManualRenderNodes } from "../engine/render/nodes/FXManualRenderNodes";
import { registerManualBehaviorNodes } from "../engine/behavior/nodes/FXManualBehaviorNodes";
import type { FXRenderNode } from "../engine/render/FXRenderNode";
import type { FXBehaviorNode } from "../engine/behavior/FXBehaviorNode";
import type { EditorGraph } from "./graphModel";
import { GraphKind, metaForNode } from "./nodePalette";
import { resolveNodeType } from "./graphTypeResolution";
import { serializeGraph } from "./serialize";

export type { FXGraphStats } from "../engine/core/compiler/collectGraphStats";

/** Lazily built once (stateless factory maps), reused across every call - mirrors sceneEmitters.ts. */
let renderRegistry: FXNodeRegistry<FXRenderNode> | undefined;
function getRenderRegistry(): FXNodeRegistry<FXRenderNode> {
  if (renderRegistry === undefined) {
    renderRegistry = new FXNodeRegistry<FXRenderNode>();
    registerStandardRenderNodes(renderRegistry);
    registerManualRenderNodes(renderRegistry);
  }
  return renderRegistry;
}

let behaviorRegistry: FXNodeRegistry<FXBehaviorNode> | undefined;
function getBehaviorRegistry(): FXNodeRegistry<FXBehaviorNode> {
  if (behaviorRegistry === undefined) {
    behaviorRegistry = new FXNodeRegistry<FXBehaviorNode>();
    registerStandardBehaviorNodes(behaviorRegistry);
    registerManualBehaviorNodes(behaviorRegistry);
  }
  return behaviorRegistry;
}

/**
 * Mints one instance per recognized snapshot entry. Never throws: an unknown type or bad param
 * mid-edit just drops that node - this is a best-effort UI stat, not a compile gate.
 */
function mintNodes<N extends FXGraphNode>(
  registry: FXNodeRegistry<N>,
  snapshot: FXGraphSnapshotData,
): Map<string, FXGraphNode> {
  const nodes = new Map<string, FXGraphNode>();
  for (const [id, data] of Object.entries(snapshot.nodes)) {
    if (!registry.has(data.type)) {
      continue;
    }
    try {
      nodes.set(id, registry.create(data.type, data.params));
    } catch {
      // Dropped - see doc comment above.
    }
  }
  return nodes;
}

/**
 * Mints and ingests `graph` into a throwaway engine `FXGraph`, optionally seeding the reachable
 * walk from only one behavior phase's output bindings - a shared behavior graph's bindings mix
 * `spawn` and `update` together, so a per-sink number needs its own phase filtered out first.
 * `phase` is meaningless for a render graph (one sink, no phase) and ignored there.
 */
function buildEngineGraph(
  kind: GraphKind,
  graph: EditorGraph,
  phase?: "spawn" | "update",
): FXGraph<FXGraphNode> {
  const snapshot = serializeGraph(graph, kind);
  const nodes =
    kind === GraphKind.Render
      ? mintNodes(getRenderRegistry(), snapshot)
      : mintNodes(getBehaviorRegistry(), snapshot);
  const outputBindings =
    phase === undefined
      ? snapshot.outputBindings
      : snapshot.outputBindings.filter((binding) => binding.phase === phase);

  const fxGraph = new FXGraph<FXGraphNode>();
  fxGraph.ingest({ nodes, connections: snapshot.connections, outputBindings });
  return fxGraph;
}

/** Node count + total complexity of `graph`'s reachable nodes (see {@link collectGraphStats}). */
export function computeGraphStats(kind: GraphKind, graph: EditorGraph): FXGraphStats {
  return collectGraphStats(buildEngineGraph(kind, graph));
}

/**
 * Reachable-only cost of a single sink, for its header badge. Render's `$out` (pass `phase`
 * `undefined`) is the whole graph's cost, same number as {@link computeGraphStats} would give;
 * a behavior sink (`"spawn"` or `"update"`) is its own phase's slice of the shared behavior graph.
 */
export function computeSinkCost(
  kind: GraphKind,
  graph: EditorGraph,
  phase?: "spawn" | "update",
): number {
  return collectGraphStats(buildEngineGraph(kind, graph, phase)).cost;
}

/**
 * Live per-node cost for the header badge - unlike {@link computeGraphStats} (reachable-only),
 * covers every recognized node regardless of wiring, resolving generic `T` via `resolveNodeType`.
 */
export function computeNodeCosts(kind: GraphKind, graph: EditorGraph): ReadonlyMap<string, number> {
  const snapshot = serializeGraph(graph, kind);
  const registry = kind === GraphKind.Render ? getRenderRegistry() : getBehaviorRegistry();
  const costs = new Map<string, number>();

  for (const [id, data] of Object.entries(snapshot.nodes)) {
    if (!registry.has(data.type)) {
      continue;
    }
    let instance: FXGraphNode;
    try {
      instance = registry.create(data.type, data.params);
    } catch {
      continue;
    }
    const editorNode = graph.nodes[id];
    const metadata =
      editorNode === undefined ? undefined : metaForNode(kind, editorNode, graph.attributes);
    const resolvedName =
      editorNode === undefined || metadata === undefined
        ? undefined
        : resolveNodeType(kind, editorNode, metadata, graph, graph.attributes, new Set());
    const resolvedT =
      resolvedName === undefined ? undefined : FX_VALUE_TYPES[resolvedName as FXValueTypeId];
    costs.set(id, instance.estimateCost?.(resolvedT) ?? 0);
  }
  return costs;
}
