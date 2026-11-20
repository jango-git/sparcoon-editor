/**
 * What the model announces: distinct events for what changed (never one generic "changed"), so a
 * subscriber reacts only to those it cares about. The {@link Store} owns them and alone emits;
 * everyone else sees them read-only, through `store.events`.
 */

import { Ferrsign0, type FerrsignView0 } from "ferrsign";

export interface EditorEvents {
  readonly sourceStructureChanged: FerrsignView0;
  readonly sourceViewChanged: FerrsignView0;
  readonly derivedChanged: FerrsignView0;
  readonly historyChanged: FerrsignView0;
}

/** The events with emit access, for the store that owns them. */
export class EditorSignals implements EditorEvents {
  public readonly sourceStructureChanged = new Ferrsign0();
  public readonly sourceViewChanged = new Ferrsign0();
  public readonly derivedChanged = new Ferrsign0();
  public readonly historyChanged = new Ferrsign0();
}
