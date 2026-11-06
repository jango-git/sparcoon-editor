/**
 * The editing half of the agent API, built over one {@link EditSession}. The same object serves
 * top-level calls (each its own transaction) and the `transaction` an `edit()` body receives (all
 * calls in one shared transaction); only the session differs.
 */

import { createGraphHandle, type GraphHandle } from "./graphEdits";
import { createSceneEdits, type SceneEdits } from "./sceneEdits";
import { createTimelineEdits, type TimelineEdits } from "./timelineEdits";
import type { EditSession } from "./transaction.Internal";

export interface EditApi {
  readonly scene: SceneEdits;
  readonly timeline: TimelineEdits;
  /** A handle on one owner's `"render"` or `"behavior"` graph. */
  graph(ownerId: string, graph: string): GraphHandle;
}

export function createEditApi(session: EditSession): EditApi {
  return {
    scene: createSceneEdits(session),
    timeline: createTimelineEdits(session),
    graph: (ownerId, graph) => createGraphHandle(session, ownerId, graph),
  };
}
