/** Reads the current selection's model data into copyable snapshots (see timelineClipboardCommands.ts for paste). */

import type { ClipboardTimelineItem } from "../../model/commands";
import type { Store } from "../../model/store";
import { emitterIdOf, findEvent, findKeyframe, findTransformKey } from "./timelineQueries";
import type { ItemRef } from "./timelineTypes";

/** Snapshots every selected item still resolvable in the store, dropping any gone since selection. */
export function copyTimelineSelection(
  store: Store,
  selection: ReadonlySet<string>,
  refByKey: ReadonlyMap<string, ItemRef>,
): readonly ClipboardTimelineItem[] {
  const items: ClipboardTimelineItem[] = [];
  for (const key of selection) {
    const ref = refByKey.get(key);
    if (ref === undefined) {
      continue;
    }
    if (ref.kind === "transformKey") {
      const found = findTransformKey(store, ref.entity, ref.id);
      if (found !== undefined) {
        items.push({
          type: "transformKey",
          entity: ref.entity,
          channel: found.channel,
          time: found.key.time,
          value: found.key.value,
        });
      }
      continue;
    }
    if (ref.kind === "key") {
      const found = findKeyframe(store, ref.entity, ref.id);
      if (found !== undefined) {
        items.push({
          type: "key",
          entity: ref.entity,
          name: found.track,
          time: found.key.time,
          value: found.key.value,
        });
      }
      continue;
    }
    const emitterId = emitterIdOf(ref);
    const event = emitterId === undefined ? undefined : findEvent(store, emitterId, ref.id);
    if (event !== undefined) {
      items.push({ type: "event", entity: ref.entity, event });
    }
  }
  return items;
}
