/**
 * The compile status the graph panel shows. The pipeline only reports on the active graph owner,
 * so asking about another owner focuses it first, as clicking it in the outliner would - but
 * without an undo step, so a status read never sits between the agent's `undo()` and its edit.
 */

import { resolveGraphOwner } from "../model/editorState";
import type { Store } from "../model/store";
import { focusOwner, resolveOwner } from "./address.Internal";
import { settle } from "./settle.Internal";
import { runUnrecorded } from "./transaction.Internal";
import { graphStatusView, type StatusView } from "./views";

export async function readStatus(store: Store, ownerId?: string): Promise<StatusView> {
  if (ownerId !== undefined) {
    runUnrecorded(store, (staging) =>
      focusOwner(staging, resolveOwner(staging.getSource(), ownerId)),
    );
  }
  await settle();
  const owner = resolveGraphOwner(store.getSource().scene);
  const derived = store.getState().derived;
  return {
    ownerId: owner?.id,
    render: graphStatusView(derived.renderStatus),
    // A VFX mesh has no behavior graph; the pipeline reports a placeholder status for it.
    behavior: owner?.kind === "emitter" ? graphStatusView(derived.behaviorStatus) : undefined,
  };
}
