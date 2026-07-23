/**
 * The editor's authored *source* graph, deliberately independent of sparcoon's runtime
 * types: the library is a view fed a serialized `FXGraphSnapshotData` (`serialize.ts`). The
 * source keeps view-only data (node positions) that never reaches the library.
 */

/** Authored and saved, but not sent to the library. */
export interface GraphPosition {
  readonly x: number;
  readonly y: number;
}

export interface GraphSocketReference {
  readonly nodeId: string;
  readonly socketKey: string;
}

/** `parameters` is a plain-data bag applied to the live instance. */
export interface GraphNode {
  readonly id: string;
  /** Registered node type string, e.g. `"color-over-life"`. */
  readonly type: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  /** View-only; excluded from the serialized library snapshot. */
  readonly position: GraphPosition;
}

export interface GraphConnection {
  readonly id: string;
  readonly from: GraphSocketReference;
  readonly to: GraphSocketReference;
}

/** Binds a node output to one of the target's output slots (e.g. `"albedo"`). */
export interface GraphOutputBinding {
  readonly slot: string;
  readonly from: GraphSocketReference;
  /**
   * Behavior only: which phase sink the binding was wired into - an authoritative placement
   * signal carried to the engine. Absent on render bindings.
   */
  readonly phase?: "spawn" | "update";
}

export interface GraphSize {
  readonly width: number;
  readonly height: number;
}

/**
 * A titled annotation rectangle drawn behind the nodes; authored and saved but never compiled
 * (not a node, no sockets, every edit view-only). Dragging one carries the nodes it encloses.
 */
export interface GraphComment {
  readonly id: string;
  /** Header text, possibly multi-line. Defaults to "Comment". */
  readonly text: string;
  /** Top-left corner in graph coordinates. */
  readonly position: GraphPosition;
  readonly size: GraphSize;
}

export type AttributeTypeName = "float" | "vec2" | "vec3" | "vec4";

/**
 * A user-declared per-particle attribute (behavior graph). Adds an `attr:<name>` write slot to
 * both phase sinks and, when wired, materializes into a `store-attribute` node at serialize
 * (whose `attributeRequest` allocates the buffer). Read via an ordinary `read-attribute` node.
 */
export interface EditorAttribute {
  readonly name: string;
  readonly type: AttributeTypeName;
}

/** A complete authored graph, render or behavior. */
export interface EditorGraph {
  readonly nodes: Readonly<Record<string, GraphNode>>;
  readonly connections: readonly GraphConnection[];
  readonly outputBindings: readonly GraphOutputBinding[];
  /** User-declared attributes (behavior graph only; empty on render). */
  readonly attributes: readonly EditorAttribute[];
  /** Annotation comment boxes drawn behind the nodes; never compiled. */
  readonly comments: readonly GraphComment[];
}

/** The starting point for a fresh document. */
export function createEmptyGraph(): EditorGraph {
  return { nodes: {}, connections: [], outputBindings: [], attributes: [], comments: [] };
}

/** The connection feeding an input socket (node-to-node edges only; sink output bindings are separate). */
export function incomingConnection(
  graph: EditorGraph,
  nodeId: string,
  socketKey: string,
): GraphConnection | undefined {
  return graph.connections.find(
    (connection) => connection.to.nodeId === nodeId && connection.to.socketKey === socketKey,
  );
}

/** Whether a node parameter is a valid keyframe value: a finite number or an array of them. */
export function isKeyframeValue(value: unknown): value is number | readonly number[] {
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}
