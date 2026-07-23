/**
 * Comment-box gestures: header-drag (carries its enclosed nodes/comments along), edge/corner
 * resize, and creation (wraps the selection, or drops a default-sized box at the cursor).
 * Bounded to its {@link CommentGestureContext}, so it stays out of the canvas's core state - the
 * same shape as {@link GraphKnife}/`KnifeContext`.
 */

import type { EditorGraph, GraphComment, GraphPosition, GraphSize } from "../../domain/graphModel";
import { addComment, moveCommentGroup, resizeComment, type GraphSlot } from "../../model/commands";
import type { Store } from "../../model/store";
import { beginPointerDrag } from "../primitives/drag";
import type { CommentHandle } from "./commentView";
import { GRID_SIZE, snapToGrid } from "./grid";
import type { GraphPoint, GraphRect } from "./graphViewport";

/** Pointer travel (px) past which a header press is a drag rather than a plain click. */
const DRAG_THRESHOLD = 3;

/** Default size of a comment added from the menu with no selection to wrap, in grid cells. */
const DEFAULT_COMMENT_CELLS = { width: 8, height: 5 };

/** Smallest a comment box may be resized to, in grid cells. */
const MIN_COMMENT_CELLS = { width: 3, height: 2 };

/** Padding (graph units) left around the selection when a comment wraps it - two grid steps. */
const COMMENT_WRAP_PADDING = GRID_SIZE * 2;

interface ViewLike {
  readonly element: HTMLElement;
  setPosition(x: number, y: number): void;
}

interface CommentViewLike extends ViewLike {
  setSize(width: number, height: number): void;
}

export interface CommentGestureContext {
  readonly store: Store;
  readonly activeSlot: () => GraphSlot;
  readonly activeGraph: () => EditorGraph;
  readonly root: HTMLElement;
  readonly scale: () => number;
  readonly nodeViews: ReadonlyMap<string, ViewLike>;
  readonly routeViews: ReadonlyMap<string, ViewLike>;
  readonly commentViews: ReadonlyMap<string, CommentViewLike>;
  readonly selected: Set<string>;
  readonly selectedComments: Set<string>;
  readonly refreshSelection: () => void;
  readonly redrawWires: () => void;
  readonly boundsOf: (
    nodeIds: readonly string[],
    commentIds: readonly string[],
  ) => GraphRect | undefined;
}

export class CommentGestures {
  constructor(private readonly ctx: CommentGestureContext) {}

  /**
   * Header pressed: select the comment and drag it. Whatever the box encloses at the start of
   * the drag - nodes, routes and nested comments - moves with it, in one view-only commit.
   */
  public onHeaderPointerDown(event: PointerEvent, commentId: string): void {
    if (event.button !== 0) {
      return;
    }
    event.stopPropagation();
    if (!event.shiftKey) {
      this.ctx.selected.clear();
      this.ctx.selectedComments.clear();
    }
    this.ctx.selectedComments.add(commentId);
    this.ctx.refreshSelection();

    const graph = this.ctx.activeGraph();
    const comment = graph.comments.find((candidate) => candidate.id === commentId);
    if (comment === undefined) {
      return;
    }
    const enclosed = this.enclosedObjects(comment);
    const commentMovers = [comment, ...enclosed.comments].map((target) => ({
      id: target.id,
      view: this.ctx.commentViews.get(target.id),
      origin: target.position,
    }));
    const nodeMovers = enclosed.nodeIds.flatMap((id) => {
      const view = this.ctx.nodeViews.get(id) ?? this.ctx.routeViews.get(id);
      const node = graph.nodes[id];
      return view !== undefined && node !== undefined ? [{ id, view, origin: node.position }] : [];
    });

    const startX = event.clientX;
    const startY = event.clientY;
    let deltaX = 0;
    let deltaY = 0;
    let moved = false;
    beginPointerDrag(this.ctx.root, event, {
      capture: false,
      onMove: (move) => {
        const scale = this.ctx.scale();
        deltaX = snapToGrid((move.clientX - startX) / scale);
        deltaY = snapToGrid((move.clientY - startY) / scale);
        if (
          Math.abs(move.clientX - startX) > DRAG_THRESHOLD ||
          Math.abs(move.clientY - startY) > DRAG_THRESHOLD
        ) {
          moved = true;
        }
        for (const mover of commentMovers) {
          mover.view?.setPosition(mover.origin.x + deltaX, mover.origin.y + deltaY);
        }
        for (const mover of nodeMovers) {
          mover.view.setPosition(mover.origin.x + deltaX, mover.origin.y + deltaY);
        }
        this.ctx.redrawWires();
      },
      onEnd: () => {
        if (moved && (deltaX !== 0 || deltaY !== 0)) {
          moveCommentGroup(
            this.ctx.store,
            this.ctx.activeSlot(),
            commentMovers.map((mover) => ({
              id: mover.id,
              position: { x: mover.origin.x + deltaX, y: mover.origin.y + deltaY },
            })),
            nodeMovers.map((mover) => ({
              nodeId: mover.id,
              position: { x: mover.origin.x + deltaX, y: mover.origin.y + deltaY },
            })),
          );
        }
      },
    });
  }

  /** An edge/corner handle pressed: resize the comment from that side, grid-snapped, min-clamped. */
  public onResize(event: PointerEvent, commentId: string, handle: CommentHandle): void {
    const graph = this.ctx.activeGraph();
    const comment = graph.comments.find((candidate) => candidate.id === commentId);
    const view = this.ctx.commentViews.get(commentId);
    if (comment === undefined || view === undefined) {
      return;
    }
    // A handle names the side(s) it drags: `w`/`e` move the left/right edge, `n`/`s` the
    // top/bottom; a corner combines one of each. A side the handle does not name stays put.
    const west = handle.includes("w");
    const east = handle.includes("e");
    const north = handle.includes("n");
    const south = handle.includes("s");
    const minWidth = MIN_COMMENT_CELLS.width * GRID_SIZE;
    const minHeight = MIN_COMMENT_CELLS.height * GRID_SIZE;
    const origin = comment.position;
    const size = comment.size;
    const startX = event.clientX;
    const startY = event.clientY;
    let rectangle = { x: origin.x, y: origin.y, width: size.width, height: size.height };

    beginPointerDrag(this.ctx.root, event, {
      capture: false,
      onMove: (move) => {
        const scale = this.ctx.scale();
        const deltaX = snapToGrid((move.clientX - startX) / scale);
        const deltaY = snapToGrid((move.clientY - startY) / scale);
        // A west/north edge moves the corner and shrinks the far side (clamped so the box never
        // collapses past its minimum); an east/south edge just extends the size.
        let left = origin.x;
        let width = size.width;
        if (west) {
          left = Math.min(origin.x + deltaX, origin.x + size.width - minWidth);
          width = origin.x + size.width - left;
        } else if (east) {
          width = Math.max(minWidth, size.width + deltaX);
        }
        let top = origin.y;
        let height = size.height;
        if (north) {
          top = Math.min(origin.y + deltaY, origin.y + size.height - minHeight);
          height = origin.y + size.height - top;
        } else if (south) {
          height = Math.max(minHeight, size.height + deltaY);
        }
        rectangle = { x: left, y: top, width, height };
        view.setPosition(left, top);
        view.setSize(width, height);
      },
      onEnd: () => {
        resizeComment(
          this.ctx.store,
          this.ctx.activeSlot(),
          commentId,
          { width: rectangle.width, height: rectangle.height },
          { x: rectangle.x, y: rectangle.y },
        );
      },
    });
  }

  /**
   * Creates a comment (the "c" hotkey - the only way to make one). With a current selection it
   * wraps the selection's bounding box (padded, grid-snapped); otherwise it drops a default-sized
   * box with its top-left at `anchor` (the cursor).
   */
  public create(anchor: GraphPoint): void {
    const bounds = this.ctx.boundsOf([...this.ctx.selected], [...this.ctx.selectedComments]);
    let position: GraphPosition;
    let size: GraphSize;
    if (bounds === undefined) {
      position = { x: snapToGrid(anchor.x), y: snapToGrid(anchor.y) };
      size = {
        width: DEFAULT_COMMENT_CELLS.width * GRID_SIZE,
        height: DEFAULT_COMMENT_CELLS.height * GRID_SIZE,
      };
    } else {
      const padding = COMMENT_WRAP_PADDING;
      // Leave extra room at the top for the header bar sitting above the wrapped nodes.
      position = {
        x: snapToGrid(bounds.minX - padding),
        y: snapToGrid(bounds.minY - padding - GRID_SIZE),
      };
      size = {
        width: snapToGrid(bounds.maxX + padding - position.x),
        height: snapToGrid(bounds.maxY + padding - position.y),
      };
    }
    const id = addComment(this.ctx.store, this.ctx.activeSlot(), position, size);
    this.ctx.selected.clear();
    this.ctx.selectedComments.clear();
    this.ctx.selectedComments.add(id);
    this.ctx.refreshSelection();
  }

  /**
   * The graph objects a comment box encloses (by their on-canvas centre): node and route ids,
   * plus other comments. Used so dragging a comment carries its contents along.
   */
  private enclosedObjects(comment: GraphComment): {
    readonly nodeIds: readonly string[];
    readonly comments: readonly GraphComment[];
  } {
    const left = comment.position.x;
    const top = comment.position.y;
    const right = left + comment.size.width;
    const bottom = top + comment.size.height;
    const inside = (x: number, y: number): boolean =>
      x >= left && x <= right && y >= top && y <= bottom;
    const graph = this.ctx.activeGraph();

    const nodeIds: string[] = [];
    for (const [id, view] of [...this.ctx.nodeViews, ...this.ctx.routeViews]) {
      const node = graph.nodes[id];
      if (node === undefined) {
        continue;
      }
      const centerX = node.position.x + view.element.offsetWidth / 2;
      const centerY = node.position.y + view.element.offsetHeight / 2;
      if (inside(centerX, centerY)) {
        nodeIds.push(id);
      }
    }
    const comments = graph.comments.filter(
      (candidate) =>
        candidate.id !== comment.id &&
        inside(
          candidate.position.x + candidate.size.width / 2,
          candidate.position.y + candidate.size.height / 2,
        ),
    );
    return { nodeIds, comments };
  }
}
