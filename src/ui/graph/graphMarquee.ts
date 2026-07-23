/**
 * The left-button rubber-band-select gesture on empty graph space. Bounded to its
 * {@link MarqueeContext} (the marquee overlay + the canvas's view maps and selection sets), so it
 * stays out of the canvas's core state - the same shape as {@link GraphKnife}/`KnifeContext`.
 */

import { beginPointerDrag } from "../primitives/drag";
import { viewsInRect, type ScreenRect } from "./graphHitTest";

/** Pointer travel (px) past which a press is a marquee drag rather than a plain click. */
const DRAG_THRESHOLD = 3;

export interface MarqueeContext {
  readonly marquee: HTMLElement;
  readonly root: HTMLElement;
  readonly nodeViews: ReadonlyMap<string, { readonly element: HTMLElement }>;
  readonly routeViews: ReadonlyMap<string, { readonly element: HTMLElement }>;
  readonly commentViews: ReadonlyMap<string, { readonly element: HTMLElement }>;
  readonly selected: Set<string>;
  readonly selectedComments: Set<string>;
  readonly refreshSelection: () => void;
}

export class GraphMarquee {
  constructor(private readonly ctx: MarqueeContext) {}

  /** Left-button gesture: a rubber-band rectangle that selects the nodes/comments it covers. */
  public begin(event: PointerEvent): void {
    const additive = event.shiftKey;
    const startX = event.clientX;
    const startY = event.clientY;
    const base = new Set(this.ctx.selected);
    const baseComments = new Set(this.ctx.selectedComments);
    beginPointerDrag(this.ctx.root, event, {
      threshold: DRAG_THRESHOLD,
      capture: false,
      onDragStart: () => {
        this.ctx.marquee.style.display = "block";
      },
      onMove: (move) => {
        const rectangle = this.updateMarquee(startX, startY, move.clientX, move.clientY);
        this.ctx.selected.clear();
        this.ctx.selectedComments.clear();
        if (additive) {
          for (const id of base) {
            this.ctx.selected.add(id);
          }
          for (const id of baseComments) {
            this.ctx.selectedComments.add(id);
          }
        }
        for (const id of this.nodesInRect(rectangle)) {
          this.ctx.selected.add(id);
        }
        for (const id of this.commentsInRect(rectangle)) {
          this.ctx.selectedComments.add(id);
        }
        this.ctx.refreshSelection();
      },
      onEnd: (_up, dragged) => {
        this.ctx.marquee.style.display = "none";
        if (
          !dragged &&
          !additive &&
          (this.ctx.selected.size > 0 || this.ctx.selectedComments.size > 0)
        ) {
          // A plain click on empty space clears the selection.
          this.ctx.selected.clear();
          this.ctx.selectedComments.clear();
          this.ctx.refreshSelection();
        }
      },
    });
  }

  /** Positions the marquee element (root-relative) and returns its screen-space rectangle. */
  private updateMarquee(startX: number, startY: number, endX: number, endY: number): ScreenRect {
    const bounds = this.ctx.root.getBoundingClientRect();
    const left = Math.min(startX, endX);
    const top = Math.min(startY, endY);
    const width = Math.abs(endX - startX);
    const height = Math.abs(endY - startY);
    this.ctx.marquee.style.left = `${left - bounds.left}px`;
    this.ctx.marquee.style.top = `${top - bounds.top}px`;
    this.ctx.marquee.style.width = `${width}px`;
    this.ctx.marquee.style.height = `${height}px`;
    return { left, top, right: left + width, bottom: top + height };
  }

  /** Node and route ids whose on-screen box intersects a screen-space rectangle. */
  private nodesInRect(rectangle: ScreenRect): readonly string[] {
    return viewsInRect([...this.ctx.nodeViews, ...this.ctx.routeViews], rectangle);
  }

  /** Comment ids whose on-screen box intersects a screen-space rectangle. */
  private commentsInRect(rectangle: ScreenRect): readonly string[] {
    return viewsInRect(this.ctx.commentViews, rectangle);
  }
}
