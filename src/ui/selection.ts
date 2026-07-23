/**
 * The one place a UI surface commits an entity pick. The VFX group is transient (the transform
 * {@link SelectionStore} only); an emitter also commits `activeEmitterId` (persisted) so it becomes
 * the graph-edited emitter. Shared by the viewport pick, the timeline rows and any other selector
 * so the dual write (persisted + transient) never drifts between call sites.
 */

import { selectEmitter, selectVfxMesh } from "../model/commands";
import type { SceneEntity } from "../model/entity";
import type { SelectionStore } from "../model/selectionStore";
import type { Store } from "../model/store";

export function commitEntitySelection(
  store: Store,
  selection: SelectionStore,
  entity: SceneEntity,
): void {
  switch (entity.kind) {
    case "vfx":
      selection.selectVfx();
      return;
    case "emitter":
      selectEmitter(store, entity.id);
      selection.selectEmitter(entity.id);
      return;
    case "vfxMesh":
      selectVfxMesh(store, entity.id);
      selection.selectVfxMesh(entity.id);
      return;
  }
}
