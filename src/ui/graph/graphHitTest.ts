/**
 * Screen-space rectangle hit-testing over the graph's views, for marquee selection. Reads each
 * view's live on-screen box; the caller passes whichever views it wants tested (nodes + routes, or
 * comments) so this stays a plain geometry query, decoupled from the canvas's view maps.
 */

/** A screen-space rectangle (client pixels). */
export interface ScreenRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Ids of the given views whose on-screen box intersects `rectangle`. */
export function viewsInRect(
  views: Iterable<readonly [string, { readonly element: HTMLElement }]>,
  rectangle: ScreenRect,
): string[] {
  const hits: string[] = [];
  for (const [id, view] of views) {
    const box = view.element.getBoundingClientRect();
    if (
      box.left < rectangle.right &&
      box.right > rectangle.left &&
      box.top < rectangle.bottom &&
      box.bottom > rectangle.top
    ) {
      hits.push(id);
    }
  }
  return hits;
}
