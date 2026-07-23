/**
 * Draws the graph's wire layer: an elbow polyline per connection and output binding, plus the
 * pending drag wire. Each edge is stroked by the data type its endpoints carry; a wire joining two
 * different types (a generic `T` meeting a concrete type) splits color at its arc-length midpoint.
 *
 * Owns only the SVG `<path>` output. Socket centres are measured from the live node DOM through the
 * injected {@link SocketCenter}, so the renderer stays decoupled from the node/route views.
 */

import type { EditorGraph } from "../../domain/graphModel";
import type { GraphKind } from "../../domain/nodePalette";
import { distance, lerpPoint } from "../primitives/geometry";
import type { GraphPoint } from "./graphViewport";
import { GRID_SIZE } from "./grid";
import type { SocketRef, SocketSide } from "./nodeView";
import { socketTypeColor } from "./socketColors";
import { resolveSocketCarriedType } from "./typeResolution";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** A wire being dragged from a fixed `anchor` socket to the cursor (graph coordinates). */
export interface PendingWire {
  readonly anchor: SocketRef;
  readonly cursor: GraphPoint;
}

/** A socket dot's centre in graph coordinates, measured from its live DOM box (or `undefined`). */
export type SocketCenter = (
  nodeId: string,
  socketKey: string,
  side: SocketSide,
) => GraphPoint | undefined;

/** The reserved sink node id an output binding targets (by slot + phase) in the active graph. */
export type SinkNodeId = (binding: {
  readonly slot: string;
  readonly phase?: "spawn" | "update" | undefined;
}) => string;

export class WireRenderer {
  constructor(
    private readonly wires: SVGSVGElement,
    private readonly socketCenter: SocketCenter,
    private readonly sinkNodeId: SinkNodeId,
  ) {}

  /** Rebuilds the wire layer from the graph's connections, bindings, and the pending drag. */
  public redraw(kind: GraphKind, graph: EditorGraph, pending: PendingWire | undefined): void {
    this.wires.replaceChildren();
    for (const connection of graph.connections) {
      const from = this.socketCenter(connection.from.nodeId, connection.from.socketKey, "output");
      const to = this.socketCenter(connection.to.nodeId, connection.to.socketKey, "input");
      if (from !== undefined && to !== undefined) {
        this.appendEdge(
          from,
          to,
          "wire",
          this.socketColorOf(
            kind,
            graph,
            connection.from.nodeId,
            connection.from.socketKey,
            "output",
          ),
          this.socketColorOf(kind, graph, connection.to.nodeId, connection.to.socketKey, "input"),
        );
      }
    }
    for (const binding of graph.outputBindings) {
      const sink = this.sinkNodeId(binding);
      const from = this.socketCenter(binding.from.nodeId, binding.from.socketKey, "output");
      const to = this.socketCenter(sink, binding.slot, "input");
      if (from !== undefined && to !== undefined) {
        this.appendEdge(
          from,
          to,
          "wire",
          this.socketColorOf(kind, graph, binding.from.nodeId, binding.from.socketKey, "output"),
          this.socketColorOf(kind, graph, sink, binding.slot, "input"),
        );
      }
    }
    if (pending !== undefined) {
      const { anchor, cursor } = pending;
      const anchorPoint = this.socketCenter(anchor.nodeId, anchor.socketKey, anchor.side);
      if (anchorPoint !== undefined) {
        const [from, to] = anchor.side === "output" ? [anchorPoint, cursor] : [cursor, anchorPoint];
        this.appendWire(from, to, "wire wire--pending", socketTypeColor(anchor.type));
      }
    }
  }

  /** The type color of one socket endpoint (the data type it carries). */
  private socketColorOf(
    kind: GraphKind,
    graph: EditorGraph,
    nodeId: string,
    socketKey: string,
    side: SocketSide,
  ): string {
    return socketTypeColor(resolveSocketCarriedType(kind, graph, nodeId, socketKey, side) ?? "T");
  }

  /**
   * Draws one edge as the usual elbow polyline. When both ends carry the same type it is a
   * single solid stroke; when they differ (a generic `T` joined to a concrete type) the
   * line switches color at its half-length point - first half the source color, second
   * half the target color (a hard midpoint split, no gradient).
   */
  private appendEdge(
    from: GraphPoint,
    to: GraphPoint,
    className: string,
    colorFrom: string,
    colorTo: string,
  ): void {
    if (colorFrom === colorTo) {
      this.appendWire(from, to, className, colorFrom);
      return;
    }
    const points = wirePoints(from, to);
    const segments = [
      { start: points[0], end: points[1] },
      { start: points[1], end: points[2] },
      { start: points[2], end: points[3] },
    ].map((segment) => ({ ...segment, length: distance(segment.start, segment.end) }));
    const total = segments.reduce((sum, segment) => sum + segment.length, 0);
    if (total === 0) {
      this.appendWire(from, to, className, colorFrom);
      return;
    }
    // Walk to the arc-length midpoint and split the polyline there.
    const half = total / 2;
    let consumed = 0;
    let splitSegmentIndex = segments.length - 1;
    let splitPoint = points[3];
    for (const [index, segment] of segments.entries()) {
      if (consumed + segment.length >= half) {
        splitSegmentIndex = index;
        splitPoint = lerpPoint(segment.start, segment.end, (half - consumed) / segment.length);
        break;
      }
      consumed += segment.length;
    }
    this.appendPolyline(
      [...points.slice(0, splitSegmentIndex + 1), splitPoint],
      className,
      colorFrom,
    );
    this.appendPolyline([splitPoint, ...points.slice(splitSegmentIndex + 1)], className, colorTo);
  }

  private appendWire(from: GraphPoint, to: GraphPoint, className: string, color: string): void {
    this.appendPolyline(wirePoints(from, to), className, color);
  }

  /** Appends a polyline through `points` as a single stroked path in `color`. */
  private appendPolyline(points: readonly GraphPoint[], className: string, color: string): void {
    if (points.length < 2) {
      return;
    }
    const pathData = points
      .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
      .join(" ");
    const path = document.createElementNS(SVG_NAMESPACE, "path");
    path.setAttribute("d", pathData);
    path.setAttribute("class", className);
    path.style.stroke = color;
    this.wires.append(path);
  }
}

/** Shortest a wire's horizontal stub may be (graph units) before it turns - at least one grid
 *  cell, so a socket sitting just before a grid line still gets a visible elbow. */
const MIN_STUB = GRID_SIZE;

/**
 * The grid line at least {@link MIN_STUB} past `x` in `direction` (`1` rightward, `-1` leftward) -
 * a socket dot rarely sits on the grid itself (it is inset within its node's dot column), so the
 * stub must snap outward to land exactly on one, not just travel a fixed pixel distance from it.
 */
function stubEnd(x: number, direction: 1 | -1): number {
  const threshold = x + direction * MIN_STUB;
  return direction > 0
    ? Math.ceil(threshold / GRID_SIZE) * GRID_SIZE
    : Math.floor(threshold / GRID_SIZE) * GRID_SIZE;
}

/** The elbow polyline (a short horizontal stub at each end, snapped to the grid) between two
 *  socket centres. Fixed at four points, so callers can destructure/index it without an
 *  out-of-bounds case under `noUncheckedIndexedAccess`. */
export function wirePoints(
  from: GraphPoint,
  to: GraphPoint,
): readonly [GraphPoint, GraphPoint, GraphPoint, GraphPoint] {
  return [from, { x: stubEnd(from.x, 1), y: from.y }, { x: stubEnd(to.x, -1), y: to.y }, to];
}
