/**
 * Replaces the whole document with an already-parsed source - the one path a picked project file,
 * a bundled preset and the agent API's project load all share.
 */

import { importProject } from "../model/commands";
import type { SourceState } from "../model/editorState";
import type { Store } from "../model/store";
import { DEFAULT_VIEWPORT_VIEW, type ViewportView } from "../model/viewportView";
import type { GizmoSettingsStore } from "../settings/gizmoSettings";
import type { PreviewSettingsStore } from "../settings/previewSettings";
import type { ViewportCamera } from "../ui/viewportCamera";

/** The stores a document replace touches beyond the document itself. */
export interface DocumentReplaceTarget {
  readonly store: Store;
  readonly previewSettings: PreviewSettingsStore;
  readonly gizmoSettings: GizmoSettingsStore;
  readonly camera: ViewportCamera;
}

/**
 * Commits `source` as one structural, undoable step (the next autosave stores its asset bytes like
 * any other edit's - see localStore.ts), then resets the viewport's own persisted settings
 * (Lighting/Scene/Gizmo) to factory defaults - they live outside the document, so a document
 * replace alone would otherwise leave the previous project's studio setup and gizmo preferences.
 * The camera moves to `camera`, the one the project was saved with, or to the default one.
 */
export function replaceDocument(
  target: DocumentReplaceTarget,
  source: SourceState,
  camera: ViewportView | undefined,
): void {
  importProject(target.store, source);
  target.previewSettings.reset();
  target.gizmoSettings.reset();
  target.camera.request(camera ?? DEFAULT_VIEWPORT_VIEW);
}
