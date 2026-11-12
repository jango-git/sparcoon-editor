/**
 * Auto-layout of the active owner's graph (`domain/layout/arrangeGraph.ts`): one structural commit,
 * so a single undo restores the graph as it was - positions, routes and comments alike.
 */

import { arrangeGraph, type LayoutGeometry } from "../../domain/layout/arrangeGraph";
import type { Store } from "../store";
import { activeGraph, type GraphSlot, kindForSlot, withGraph } from "./graphAccess.Internal";
import { nextIdentifier } from "./identifier";

export function arrangeActiveGraph(store: Store, slot: GraphSlot, geometry: LayoutGeometry): void {
  const source = store.getSource();
  const arranged = arrangeGraph(activeGraph(source, slot), kindForSlot(slot), {
    ...geometry,
    mintId: nextIdentifier,
  });
  store.commit(
    withGraph(source, slot, () => arranged),
    "structural",
  );
}
