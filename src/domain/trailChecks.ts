/**
 * The checks an emitter's trail graph is held to beyond its own compile - shared by the live
 * preview and the export, so the two never accept different trails - and the geometry a trail
 * artifact names (the runtime builds a trail's own segment quad and ignores it).
 */

import type { FXGeometrySource } from "sparcoon";
import { mergeAttributeCollections } from "../engine/core/compiler/collectAttributeRequests";
import type { FXCompilerError } from "../engine/core/compiler/FXCompilerError";
import type { FXAttributeRequest } from "../engine/core/socket/FXAttribute";
import type { EditorAttribute } from "./graphModel";
import { undeclaredAttributeErrors } from "./serialize";
import { RENDER_SINK_ID } from "./sinkMeta";

/** The geometry every trail artifact carries. */
export const TRAIL_GEOMETRY: FXGeometrySource = { type: "primitive", primitive: "plane" };

/**
 * A trail on a depth-sorted emitter: a sort moves particles between slots, and a trail records
 * each slot's path. Attributed to the render graph's surface sink, where Sort Every lives.
 */
export function trailSortError(sortInterval: number): FXCompilerError | undefined {
  return sortInterval > 0
    ? {
        code: "trail-with-sort",
        message:
          "a trail cannot be combined with depth sorting - set the render graph's Sort Every to 0",
        nodeId: RENDER_SINK_ID,
      }
    : undefined;
}

/**
 * The trail's attribute reads against the behavior graph: a read at another width than the
 * behavior writes it, or of an attribute the emitter does not declare.
 */
export function trailAttributeErrors(
  trailAttributes: readonly FXAttributeRequest[],
  behaviorAttributes: readonly FXAttributeRequest[],
  declared: readonly EditorAttribute[],
): readonly FXCompilerError[] {
  return [
    ...mergeAttributeCollections(
      { requests: trailAttributes, errors: [] },
      { requests: behaviorAttributes, errors: [] },
    ).errors,
    ...undeclaredAttributeErrors(trailAttributes, [], declared),
  ];
}
