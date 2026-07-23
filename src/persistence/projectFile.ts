/**
 * The project file format: the whole `SourceState` (assets inlined as base64 data URLs, exactly as
 * persisted) wrapped in a small envelope carrying a format tag and version - both are written but
 * not currently checked on load; validity instead comes entirely from {@link normalizeSource}
 * structurally accepting or rejecting the unwrapped body. No migration exists (the editor is
 * unreleased) and none is implied by the version field as it stands today.
 *
 * Serialize is a plain stringify; deserialize parses, unwraps the envelope (keyed on the presence of
 * a `source` property, not the format tag) and hands the body to the same {@link normalizeSource}
 * that defends the persisted document, so an imported file - untrusted like any storage - can never
 * crash the editor. A bare source (no envelope) is tolerated the same way.
 */

import { seedIdentifierCounterFromRawSource } from "../model/commands/documentIdentifiers";
import type { SourceState } from "../model/editorState";
import { isRecord } from "../util/guards";
import { normalizeSource } from "./loadState";

const PROJECT_FORMAT = "sparcoon-project";
const PROJECT_VERSION = 1;

export function serializeProject(source: SourceState): string {
  return JSON.stringify({ format: PROJECT_FORMAT, version: PROJECT_VERSION, source }, undefined, 2);
}

/** Parses project-file text to a valid source, or `undefined` when it is unreadable or not a project. */
export function deserializeProject(text: string): SourceState | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  // Unwrap the { format, version, source } envelope; fall through to the raw value so a hand-authored
  // bare source still loads. normalizeSource returns undefined for anything that isn't a real scene.
  const body = isRecord(raw) && "source" in raw ? raw["source"] : raw;
  // Seed from the raw body *before* normalizing - see seedIdentifierCounterFromRawSource's doc.
  seedIdentifierCounterFromRawSource(body);
  return normalizeSource(body);
}
