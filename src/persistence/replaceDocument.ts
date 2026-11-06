/**
 * Replaces the whole document with an already-parsed source - the one path a picked project file,
 * a bundled preset and the agent API's project load all share.
 */

import { importProject } from "../model/commands";
import type { SourceState } from "../model/editorState";
import type { Store } from "../model/store";
import type { GizmoSettingsStore } from "../settings/gizmoSettings";
import type { PreviewSettingsStore } from "../settings/previewSettings";
import { hydrateEnvironmentBlobs } from "./environmentBlobStore";

/** The stores a document replace touches beyond the document itself. */
export interface DocumentReplaceTarget {
  readonly store: Store;
  readonly previewSettings: PreviewSettingsStore;
  readonly gizmoSettings: GizmoSettingsStore;
}

/**
 * Stores the incoming HDRI blobs (so the next autosave keeps them), commits `source` as one
 * structural, undoable step, then resets the viewport's own persisted settings
 * (Lighting/Scene/Gizmo) to factory defaults - they live outside the document, so a document
 * replace alone would otherwise leave the previous project's studio setup and gizmo preferences.
 */
export async function replaceDocument(
  target: DocumentReplaceTarget,
  source: SourceState,
): Promise<void> {
  await hydrateEnvironmentBlobs(source.environments);
  importProject(target.store, source);
  target.previewSettings.reset();
  target.gizmoSettings.reset();
}
