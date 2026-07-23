/**
 * Edge wrapping for the modal transform tool: a drag leaving one side of the viewport re-enters
 * from the opposite side, so a move is never cut short by the window. Nothing in the browser can
 * warp the OS cursor, so the drag holds a pointer lock instead - locked move events report raw
 * movement that keeps coming past the screen edge, and the position it accumulates into is ours to
 * wrap. The lock hides the real cursor, hence the stand-in one drawn here. A browser that refuses
 * the lock leaves the tool on plain client coordinates, unwrapped.
 */

import { Vector2 } from "three";
import { createElement } from "../dom";

/** Wraps `point` (client px) into `rect`, so leaving one edge re-enters from the opposite one. */
export function wrapIntoRect(point: Vector2, rect: DOMRect): Vector2 {
  return new Vector2(
    rect.left + foldInto(point.x - rect.left, rect.width),
    rect.top + foldInto(point.y - rect.top, rect.height),
  );
}

/** `value` folded into `[0, span)`; a collapsed span has no inside to fold into. */
function foldInto(value: number, span: number): number {
  return span > 0 ? ((value % span) + span) % span : value;
}

export class WrappedPointer {
  private cursor: HTMLElement | undefined;
  private readonly position = new Vector2();

  constructor(private readonly viewport: HTMLElement) {
    // The lock engages asynchronously and can drop at any time, so the stand-in cursor follows the
    // lock state rather than the request that asked for it.
    document.addEventListener("pointerlockchange", () => this.paintCursor());
  }

  /** Whether the lock is live - only then do move events report wrappable movement deltas. */
  public isEngaged(): boolean {
    return document.pointerLockElement === this.viewport;
  }

  /** Asks for the lock, with `at` (client px) as the stand-in cursor's first position. Must run
   *  inside a user gesture (the G/R/S keypress); browsers refuse the lock outside one. */
  public engage(at: Vector2): void {
    this.position.copy(at);
    // A refusal (no gesture, or Chrome's cooldown right after an Esc release) is not actionable -
    // the drag just runs unwrapped - but older browsers return nothing at all instead of a promise.
    const request: unknown = this.viewport.requestPointerLock();
    if (request instanceof Promise) {
      void request.catch(() => undefined);
    }
  }

  /** Moves the stand-in cursor to `at` (client px) - the wrapped position, not the raw one. */
  public moveTo(at: Vector2): void {
    this.position.copy(at);
    this.paintCursor();
  }

  public release(): void {
    if (this.isEngaged()) {
      document.exitPointerLock();
    }
    this.cursor?.remove();
  }

  private paintCursor(): void {
    const parent = this.viewport.parentElement ?? undefined;
    if (!this.isEngaged() || parent === undefined) {
      this.cursor?.remove();
      return;
    }
    const cursor = this.cursor ?? createElement("div", { className: "viewport-cursor" });
    this.cursor = cursor;
    if (cursor.parentElement !== parent) {
      parent.append(cursor);
    }
    const rect = parent.getBoundingClientRect();
    cursor.style.left = `${this.position.x - rect.left}px`;
    cursor.style.top = `${this.position.y - rect.top}px`;
  }
}
