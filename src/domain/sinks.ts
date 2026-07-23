/**
 * The permanent output **sink** nodes every graph carries (behavior: `spawn` + `update`; render:
 * the surface `$out`). Stored as an ordinary {@link GraphNode} so it reconciles/selects like any
 * node, but is never addable or deletable; `serialize.ts` drops sinks - outputs become bindings.
 */

import type { EditorGraph, GraphNode, GraphPosition } from "./graphModel";
import {
  DEFAULT_GEOMETRY,
  DEFAULT_RENDER_MODE,
  GraphKind,
  RENDER_SINK_ID,
  RENDER_SINK_TYPE,
  SPAWN_SINK_ID,
  SPAWN_SINK_TYPE,
  UPDATE_SINK_ID,
  UPDATE_SINK_TYPE,
  isSinkType,
} from "./nodePalette";

/** Default canvas placements: sinks sit to the right; the two behavior sinks stack. */
const SPAWN_SINK_POSITION: GraphPosition = { x: 480, y: 72 };
const UPDATE_SINK_POSITION: GraphPosition = { x: 480, y: 264 };
const RENDER_SINK_POSITION: GraphPosition = { x: 480, y: 96 };

export function isSink(node: Pick<GraphNode, "type"> | undefined): boolean {
  return node !== undefined && isSinkType(node.type);
}

function makeSink(
  id: string,
  type: string,
  position: GraphPosition,
  parameters: Record<string, unknown> = {},
): GraphNode {
  return { id, type, parameters, position };
}

function createBehaviorSinks(): readonly GraphNode[] {
  return [
    makeSink(SPAWN_SINK_ID, SPAWN_SINK_TYPE, SPAWN_SINK_POSITION),
    makeSink(UPDATE_SINK_ID, UPDATE_SINK_TYPE, UPDATE_SINK_POSITION),
  ];
}

/** The surface sink: albedo + transforms + geometry/render-mode/sort (lighting-model-independent). */
export function createRenderSink(): GraphNode {
  return makeSink(RENDER_SINK_ID, RENDER_SINK_TYPE, RENDER_SINK_POSITION, {
    geometry: DEFAULT_GEOMETRY,
    renderMode: DEFAULT_RENDER_MODE,
  });
}

function sinksFor(kind: GraphKind): readonly GraphNode[] {
  return kind === GraphKind.Render ? [createRenderSink()] : createBehaviorSinks();
}

/**
 * `graph` guaranteed to carry every sink its `kind` requires, adding any missing. Idempotent:
 * a graph that already has them is returned by the same reference (matters on document load).
 */
export function ensureSinks(graph: EditorGraph, kind: GraphKind): EditorGraph {
  const required = sinksFor(kind);
  const missing = required.filter((sink) => graph.nodes[sink.id]?.type !== sink.type);
  if (missing.length === 0) {
    return graph;
  }
  const nodes = { ...graph.nodes };
  for (const sink of missing) {
    nodes[sink.id] = sink;
  }
  return { ...graph, nodes };
}
