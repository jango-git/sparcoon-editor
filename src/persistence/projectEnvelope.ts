/**
 * The envelope every stored project is kept in - the project file, the presets and the autosaved
 * document alike: the whole `SourceState` and what says how to read it.
 *
 * `version` is the format's number. A change to what a saved project means - a renamed or removed
 * node, input, output or field, a new shape, a missing field that should read as something other
 * than its default - adds a step to {@link PROJECT_UPGRADES}, which bumps the number, and the load
 * runs an older project through the steps from its number up. `normalizeSource` then reads the
 * current format only: it drops what is damaged and gives a missing field its default. A field
 * added with a default an older project reads right with keeps the number. `editor` is the version
 * of the editor that saved the project, for the reader; the load does not depend on it. `camera`
 * is the viewport camera the project file was saved with (see `model/viewportView.ts`), outside
 * `source` since it is not part of the document; the autosaved document has none.
 *
 * A bare source (no envelope) and an envelope without a valid number read as format 1.
 */

import { readViewportView, type ViewportView } from "../model/viewportView";
import { isRecord } from "../util/guards";
import { upgradeFromFormat1 } from "./upgrades/fromFormat1";
import { upgradeFromFormat2 } from "./upgrades/fromFormat2";

const PROJECT_FORMAT = "sparcoon-project";

/** Converts a project body of one format to the next. The body is untrusted, as the stored one. */
export type ProjectUpgrade = (body: unknown) => unknown;

/**
 * The steps between formats, in order: step `i` converts format `i + 1` to `i + 2`. A step is
 * never edited or removed once released, since projects saved in its formats still load through it.
 */
const PROJECT_UPGRADES: readonly ProjectUpgrade[] = [upgradeFromFormat1, upgradeFromFormat2];

/** The current format: one past the last step. */
const PROJECT_VERSION = PROJECT_UPGRADES.length + 1;

export interface ProjectEnvelope {
  readonly format: typeof PROJECT_FORMAT;
  readonly version: number;
  readonly editor: string;
  readonly camera?: ViewportView;
  readonly source: unknown;
}

/** A stored project, unwrapped: its body and what the envelope says about it. */
export interface StoredProject {
  readonly body: unknown;
  readonly version: number;
  /** The editor that saved it, when the envelope names one. */
  readonly editor: string | undefined;
  /** The viewport camera it was saved with, when the envelope holds a valid one. */
  readonly camera: ViewportView | undefined;
}

export function wrapProject(source: unknown, camera?: ViewportView): ProjectEnvelope {
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    editor: SPARCOON_EDITOR_VERSION,
    ...(camera !== undefined ? { camera } : {}),
    source,
  };
}

/** The body of a stored project and what its envelope says, keyed on the presence of `source`. */
export function unwrapProject(raw: unknown): StoredProject {
  if (!isRecord(raw) || !("source" in raw)) {
    return { body: raw, version: 1, editor: undefined, camera: undefined };
  }
  const version = raw["version"];
  const editor = raw["editor"];
  return {
    body: raw["source"],
    version: typeof version === "number" && Number.isInteger(version) && version >= 1 ? version : 1,
    editor: typeof editor === "string" ? editor : undefined,
    camera: readViewportView(raw["camera"]),
  };
}

/** Whether `stored` is in a format later than this editor's: reading it would lose data. */
export function isNewerProject(stored: StoredProject): boolean {
  return stored.version > PROJECT_VERSION;
}

/** `stored`'s body in the current format: run through every step from its format up. A project in a
 *  later format comes back as it is. */
export function upgradeProject(
  stored: StoredProject,
  upgrades: readonly ProjectUpgrade[] = PROJECT_UPGRADES,
): unknown {
  return upgrades.slice(stored.version - 1).reduce((body, upgrade) => upgrade(body), stored.body);
}
