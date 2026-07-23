/**
 * Pure 2D geometry kernel. These were inlined as module-private helpers in graphCanvas
 * (wire hit-testing, knife-cut segment crossing, marquee AABB) and re-derived again for the
 * preview pick / transform tool (client-pixel -> NDC). No DOM, no framework - just math.
 *
 * `Point2` is structural (`{ x, y }`), so graph-space `GraphPoint`s and three.js `Vector2`s
 * pass straight in without conversion.
 */

import { clamp01 } from "./math";

export interface Point2 {
  readonly x: number;
  readonly y: number;
}

/** A screen-space axis-aligned box in the shape `getBoundingClientRect()` returns (client px). */
export interface Bounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export function distance(from: Point2, to: Point2): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

export function lerpPoint(start: Point2, end: Point2, fraction: number): Point2 {
  return {
    x: start.x + (end.x - start.x) * fraction,
    y: start.y + (end.y - start.y) * fraction,
  };
}

/** Shortest distance from `point` to the segment `[start, end]`. */
export function distanceToSegment(point: Point2, start: Point2, end: Point2): number {
  const spanX = end.x - start.x;
  const spanY = end.y - start.y;
  const lengthSquared = spanX * spanX + spanY * spanY;
  if (lengthSquared === 0) {
    return distance(point, start);
  }
  const fraction = clamp01(
    ((point.x - start.x) * spanX + (point.y - start.y) * spanY) / lengthSquared,
  );
  return distance(point, { x: start.x + fraction * spanX, y: start.y + fraction * spanY });
}

/**
 * Signed area (x2) of the triangle `(segmentStart, segmentEnd, point)`: the orientation of the
 * turn - positive is one way round, negative the other, zero collinear.
 */
export function crossProduct(segmentStart: Point2, segmentEnd: Point2, point: Point2): number {
  return (
    (segmentEnd.x - segmentStart.x) * (point.y - segmentStart.y) -
    (segmentEnd.y - segmentStart.y) * (point.x - segmentStart.x)
  );
}

/** Whether segments `[a1, a2]` and `[b1, b2]` properly cross (touching endpoints don't count). */
export function segmentsIntersect(a1: Point2, a2: Point2, b1: Point2, b2: Point2): boolean {
  const orientationA1 = crossProduct(b1, b2, a1);
  const orientationA2 = crossProduct(b1, b2, a2);
  const orientationB1 = crossProduct(a1, a2, b1);
  const orientationB2 = crossProduct(a1, a2, b2);
  return (
    ((orientationA1 > 0 && orientationA2 < 0) || (orientationA1 < 0 && orientationA2 > 0)) &&
    ((orientationB1 > 0 && orientationB2 < 0) || (orientationB1 < 0 && orientationB2 > 0))
  );
}

/**
 * Consecutive `[previous, current]` pairs of `items` (a walk of the polyline's edges). Built via
 * `for...of` rather than indexing so `previous` is proven non-null by the `!== undefined` guard,
 * not asserted - `noUncheckedIndexedAccess` cannot narrow index reads the way it can a local.
 */
function consecutivePairs<Value>(items: readonly Value[]): (readonly [Value, Value])[] {
  const pairs: (readonly [Value, Value])[] = [];
  let previous: Value | undefined;
  for (const item of items) {
    if (previous !== undefined) {
      pairs.push([previous, item]);
    }
    previous = item;
  }
  return pairs;
}

/** Whether any segment of `stroke` crosses any segment of `polyline` (knife-cut hit test). */
export function strokeCrossesPolyline(
  stroke: readonly Point2[],
  polyline: readonly Point2[],
): boolean {
  for (const [strokeStart, strokeEnd] of consecutivePairs(stroke)) {
    for (const [polylineStart, polylineEnd] of consecutivePairs(polyline)) {
      if (segmentsIntersect(strokeStart, strokeEnd, polylineStart, polylineEnd)) {
        return true;
      }
    }
  }
  return false;
}

export function pointInBounds(point: Point2, bounds: Bounds): boolean {
  return (
    point.x >= bounds.left &&
    point.x <= bounds.right &&
    point.y >= bounds.top &&
    point.y <= bounds.bottom
  );
}

/** Whether two axis-aligned boxes overlap (marquee-vs-node selection). */
export function boundsIntersect(first: Bounds, second: Bounds): boolean {
  return (
    first.left <= second.right &&
    first.right >= second.left &&
    first.top <= second.bottom &&
    first.bottom >= second.top
  );
}

/**
 * Client-pixel coordinates -> normalized device coordinates ([-1, 1], y up) for a canvas whose
 * screen box is `rectangle`. The preview pick and the transform tool both need this from a raw event.
 */
export function toNormalizedDeviceCoordinates(
  clientX: number,
  clientY: number,
  rectangle: DOMRect,
): Point2 {
  return {
    x: ((clientX - rectangle.left) / rectangle.width) * 2 - 1,
    y: -((clientY - rectangle.top) / rectangle.height) * 2 + 1,
  };
}

/**
 * Horizontal position of `clientX` within `rectangle` as a fraction clamped to [0, 1] (0 for a
 * zero-width rectangle). The 1D pointer-to-value map shared by gradient bars, curve plots and time lanes.
 */
export function fractionAcross(clientX: number, rectangle: DOMRect): number {
  return rectangle.width === 0 ? 0 : clamp01((clientX - rectangle.left) / rectangle.width);
}
