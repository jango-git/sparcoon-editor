/**
 * The editor's ambient services (long-lived stores + focus/hotkey plumbing) bundled into one object
 * so constructors take a single `context` param instead of threading each service separately. Holds
 * only process-wide singletons - never panel-local/render-layer objects; `graphView` (Render vs
 * Behavior) is workspace-scoped and stays owned by the app shell, not here.
 */

import type { SelectionStore } from "../model/selectionStore";
import type { Store } from "../model/store";
import type { TransportStore } from "../model/transport";
import type { GizmoSettingsStore } from "../settings/gizmoSettings";
import type { PreviewSettingsStore } from "../settings/previewSettings";
import type { HotkeyRouter } from "./focus/hotkeyRouter";
import type { PanelFocus } from "./focus/panelFocus";
import type { PanelFocusTracker } from "./focus/panelFocusTracker";
import type { InputModeState } from "./inputMode";
import type { PreviewViewModeState } from "./previewViewMode";

export interface EditorContext {
  readonly store: Store;
  readonly transport: TransportStore;
  readonly router: HotkeyRouter;
  readonly panelFocus: PanelFocus;
  readonly panelFocusTracker: PanelFocusTracker;
  /** The transform selection (gizmo/hotkey target): the VFX group or one emitter. */
  readonly selection: SelectionStore;
  readonly inputMode: InputModeState;
  readonly previewSettings: PreviewSettingsStore;
  /** What the viewport shows: the shaded frame or an overdraw view. */
  readonly viewMode: PreviewViewModeState;
  readonly gizmoSettings: GizmoSettingsStore;
}
