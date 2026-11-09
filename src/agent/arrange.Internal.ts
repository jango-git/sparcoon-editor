/**
 * `arrange()`: the graph's Arrange button, for an agent. The layout measures the cards on the live
 * canvas, so the editor first shows the graph - its owner focused without an undo step (as a
 * status read does), the graph switched to - and the arrangement itself is the one undo step.
 */

import type { GraphName } from "../model/graphSlots";
import type { Store } from "../model/store";
import { focusOwner, parseGraphName, resolveGraph } from "./address.Internal";
import { runUnrecorded } from "./transaction.Internal";

export function arrangeOwnerGraph(
  store: Store,
  arrangeShownGraph: (name: GraphName) => void,
  ownerId: string,
  graph: string,
): void {
  const target = resolveGraph(store.getSource(), ownerId, parseGraphName(graph));
  runUnrecorded(store, (staging) => focusOwner(staging, target.owner));
  arrangeShownGraph(target.name);
}
