/**
 * The envelope every stored project is kept in - the project file, the presets and the autosaved
 * document alike: the whole `SourceState` and what says how to read it.
 *
 * `version` is the format's number. A change an older project cannot be read through as it is bumps
 * it, and the load converts an older project step by step up to the current number before
 * `normalizeSource` reads it. Changes it can be read through - added fields, renamed nodes - keep
 * the number: `normalizeSource` gives a missing field its default and maps old names whatever the
 * project's number. `editor` is the version of the editor that saved the project, for the reader;
 * the load does not depend on it.
 *
 * A bare source (no envelope) and an envelope without a number read as format 1.
 */

import { isRecord } from "../util/guards";

const PROJECT_FORMAT = "sparcoon-project";
const PROJECT_VERSION = 1;

export interface ProjectEnvelope {
  readonly format: typeof PROJECT_FORMAT;
  readonly version: number;
  readonly editor: string;
  readonly source: unknown;
}

/** A stored project, unwrapped: its body and what the envelope says about it. */
export interface StoredProject {
  readonly body: unknown;
  readonly version: number;
  /** The editor that saved it, when the envelope names one. */
  readonly editor: string | undefined;
}

export function wrapProject(source: unknown): ProjectEnvelope {
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    editor: SPARCOON_EDITOR_VERSION,
    source,
  };
}

/** The body of a stored project and what its envelope says, keyed on the presence of `source`. */
export function unwrapProject(raw: unknown): StoredProject {
  if (!isRecord(raw) || !("source" in raw)) {
    return { body: raw, version: 1, editor: undefined };
  }
  const version = raw["version"];
  const editor = raw["editor"];
  return {
    body: raw["source"],
    version: typeof version === "number" && Number.isInteger(version) ? version : 1,
    editor: typeof editor === "string" ? editor : undefined,
  };
}

/** Whether `stored` is in a format later than this editor's: reading it would lose data. */
export function isNewerProject(stored: StoredProject): boolean {
  return stored.version > PROJECT_VERSION;
}
