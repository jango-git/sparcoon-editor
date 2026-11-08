/**
 * The graphs an entity authors, named once: for each graph name (`"render"`/`"behavior"`/
 * `"trail"`), the document field it lives in, the palette kind it draws from, the derived status
 * the pipeline reports it under, and the render host its surface sink is shaped for. Every layer
 * that maps between these (the graph commands, the agent API, the graph canvas and panel, the
 * scene sync) reads this one table rather than its own switch.
 */

import type { EditorGraph } from "../domain/graphModel";
import { GraphKind, type RenderHost } from "../domain/nodePalette";
import type { GraphOwnerKind } from "./editorState";

/** An authored graph, by the name the agent API and the graph switch use. */
export type GraphName = "render" | "behavior" | "trail";

/** The document field holding a graph - what the graph commands target. The trail graph is
 *  render-kind (render nodes, the surface sink) on the trail host. */
export type GraphSlot = "renderGraph" | "behaviorGraph" | "trailGraph";

/** Everything one graph name maps to. */
export interface GraphSlotInfo {
  readonly slot: GraphSlot;
  readonly kind: GraphKind;
  /** The `DerivedState` field the pipeline reports this graph's compile status under. */
  readonly status: "renderStatus" | "behaviorStatus" | "trailStatus";
  /** The render host this graph's surface sink is shaped for on an emitter (a VFX mesh's render
   *  graph is on the mesh host instead - see {@link renderHostFor}). */
  readonly emitterHost: RenderHost;
}

/** The graph table, in the order an emitter's graphs are listed (see {@link GRAPH_NAMES}). */
export const GRAPH_SLOTS: Readonly<Record<GraphName, GraphSlotInfo>> = {
  render: {
    slot: "renderGraph",
    kind: GraphKind.Render,
    status: "renderStatus",
    emitterHost: "particle",
  },
  behavior: {
    slot: "behaviorGraph",
    kind: GraphKind.Behavior,
    status: "behaviorStatus",
    emitterHost: "particle",
  },
  trail: {
    slot: "trailGraph",
    kind: GraphKind.Render,
    status: "trailStatus",
    emitterHost: "trail",
  },
};

/** Every graph name, in the order an entity's graphs are listed (render, behavior, trail). */
const GRAPH_NAMES: readonly GraphName[] = ["render", "behavior", "trail"];

const NAME_BY_SLOT: Readonly<Record<GraphSlot, GraphName>> = {
  renderGraph: "render",
  behaviorGraph: "behavior",
  trailGraph: "trail",
};

/** The name of the graph a document field holds. */
function graphNameForSlot(slot: GraphSlot): GraphName {
  return NAME_BY_SLOT[slot];
}

/** The palette kind the graph in `slot` draws from. */
export function kindForSlot(slot: GraphSlot): GraphKind {
  return GRAPH_SLOTS[graphNameForSlot(slot)].kind;
}

/** The render host graph `name` of an `owner`-kind entity draws on: a VFX mesh's render graph is
 *  on the mesh host, an emitter's on {@link GraphSlotInfo.emitterHost}. */
export function renderHostFor(owner: GraphOwnerKind, name: GraphName): RenderHost {
  return owner === "vfxMesh" ? "mesh" : GRAPH_SLOTS[name].emitterHost;
}

/** One authored graph of an entity, with its name. */
export interface NamedGraph {
  readonly name: GraphName;
  readonly graph: EditorGraph;
}

/**
 * Every graph `owner` authors, named, in {@link GRAPH_NAMES} order: an emitter's render and
 * behavior graphs and its trail when it has one, or a VFX mesh's lone render graph.
 */
export function authoredGraphs(
  owner: Readonly<Partial<Record<GraphSlot, EditorGraph>>>,
): readonly NamedGraph[] {
  return GRAPH_NAMES.flatMap((name) => {
    const graph = owner[GRAPH_SLOTS[name].slot];
    return graph === undefined ? [] : [{ name, graph }];
  });
}
