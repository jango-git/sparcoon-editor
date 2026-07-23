/**
 * The Alt+left "knife" gesture on empty graph space: a plain click on a wire inserts a route there;
 * a drag draws a red knife stroke and, on release, cuts every wire the stroke crossed. Bounded to
 * its {@link KnifeContext} (the knife overlay + graph geometry + store), so it stays out of the
 * canvas's core state.
 */

import {
  insertRouteOnBinding,
  insertRouteOnConnection,
  removeEdges,
  type GraphSlot,
} from "../../model/commands";
import type { GraphPosition } from "../../domain/graphModel";
import type { Store } from "../../model/store";
import { beginPointerDrag } from "../primitives/drag";
import { strokeCrossesPolyline } from "../primitives/geometry";
import type { GraphPoint } from "./graphViewport";
import { GRID_SIZE, snapToGrid } from "./grid";
import type { GraphEdge } from "./wireHitTest";

const SVG_NS = "http://www.w3.org/2000/svg";
/** Pointer travel (px) past which the Alt-press is a knife drag rather than a route-insert click. */
const DRAG_THRESHOLD = 3;

export interface KnifeContext {
  readonly knife: SVGSVGElement;
  readonly root: HTMLElement;
  readonly store: Store;
  readonly activeSlot: () => GraphSlot;
  readonly graphPoint: (clientX: number, clientY: number) => GraphPoint;
  readonly edgeNearPoint: (point: GraphPoint) => GraphEdge | undefined;
  readonly collectEdges: () => GraphEdge[];
}

export class GraphKnife {
  constructor(private readonly ctx: KnifeContext) {}

  /**
   * Begins the Alt+left gesture from `event`: track the pointer; a plain click (no drag past the
   * threshold) that lands on a wire inserts a route there, while a drag draws a knife stroke and,
   * on release, cuts every wire the stroke crossed.
   */
  public begin(event: PointerEvent): void {
    const clientPath: GraphPoint[] = [{ x: event.clientX, y: event.clientY }];
    beginPointerDrag(this.ctx.root, event, {
      threshold: DRAG_THRESHOLD,
      capture: false,
      onDragStart: () => {
        this.ctx.knife.style.display = "block";
      },
      onMove: (move) => {
        clientPath.push({ x: move.clientX, y: move.clientY });
        this.drawKnife(clientPath);
      },
      onEnd: (up, dragged) => {
        this.ctx.knife.style.display = "none";
        this.ctx.knife.replaceChildren();
        if (dragged) {
          this.cutWiresAcross(clientPath);
        } else {
          this.insertRouteAtScreenPoint(up.clientX, up.clientY);
        }
      },
    });
  }

  /** Renders the knife stroke (client points -> root-relative) as a red polyline overlay. */
  private drawKnife(clientPath: readonly GraphPoint[]): void {
    const bounds = this.ctx.root.getBoundingClientRect();
    const pathData = clientPath
      .map(
        (point, index) =>
          `${index === 0 ? "M" : "L"} ${point.x - bounds.left} ${point.y - bounds.top}`,
      )
      .join(" ");
    let path = this.ctx.knife.firstElementChild ?? undefined;
    if (path === undefined) {
      path = document.createElementNS(SVG_NS, "path");
      this.ctx.knife.append(path);
    }
    path.setAttribute("d", pathData);
  }

  /** Inserts a route onto the wire under a screen point, if one passes close enough. */
  private insertRouteAtScreenPoint(clientX: number, clientY: number): void {
    const point = this.ctx.graphPoint(clientX, clientY);
    const hit = this.ctx.edgeNearPoint(point);
    if (hit === undefined) {
      return;
    }
    // Centre the two-cell route knot on the click point, snapped to the grid.
    const position: GraphPosition = {
      x: snapToGrid(point.x - GRID_SIZE),
      y: snapToGrid(point.y - GRID_SIZE / 2),
    };
    if (hit.descriptor.kind === "connection") {
      insertRouteOnConnection(this.ctx.store, this.ctx.activeSlot(), hit.descriptor.id, position);
    } else {
      insertRouteOnBinding(
        this.ctx.store,
        this.ctx.activeSlot(),
        hit.descriptor.slot,
        hit.descriptor.phase,
        position,
      );
    }
  }

  /** Removes every wire whose polyline the knife stroke crossed, in one commit. */
  private cutWiresAcross(clientPath: readonly GraphPoint[]): void {
    const stroke = clientPath.map((point) => this.ctx.graphPoint(point.x, point.y));
    const connectionIds: string[] = [];
    const bindings: { slot: string; phase: "spawn" | "update" | undefined }[] = [];
    for (const edge of this.ctx.collectEdges()) {
      if (!strokeCrossesPolyline(stroke, edge.points)) {
        continue;
      }
      if (edge.descriptor.kind === "connection") {
        connectionIds.push(edge.descriptor.id);
      } else {
        bindings.push({ slot: edge.descriptor.slot, phase: edge.descriptor.phase });
      }
    }
    removeEdges(this.ctx.store, this.ctx.activeSlot(), { connectionIds, bindings });
  }
}
