/**
 * What the model announces: distinct events for what changed (never one generic "changed"), so a
 * subscriber reacts only to those it cares about. The {@link Store} owns them and alone emits;
 * everyone else sees them read-only, through `store.events`.
 */

import { Ferrsign0, type FerrsignView0 } from "ferrsign";

export interface EditorEvents {
  /** Source changed structurally; the derived pipeline must recompute. */
  readonly sourceStructureChanged: FerrsignView0;
  /** Source changed in a view-only way (e.g. node moved); no recompute needed. */
  readonly sourceViewChanged: FerrsignView0;
  /** Derived render/behavior snapshots were recomputed and applied. */
  readonly derivedChanged: FerrsignView0;
  /** Undo/redo availability changed. */
  readonly historyChanged: FerrsignView0;
}

/** The events with emit access, for the store that owns them. */
export class EditorSignals implements EditorEvents {
  public readonly sourceStructureChanged = new Ferrsign0();
  public readonly sourceViewChanged = new Ferrsign0();
  public readonly derivedChanged = new Ferrsign0();
  public readonly historyChanged = new Ferrsign0();
}
