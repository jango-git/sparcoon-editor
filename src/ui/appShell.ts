/**
 * Builds the workspace frame: a top region (preview and graph, above the bottom band) over a bottom
 * band (timeline; also the object outline). The dividers between them are draggable (see
 * {@link createWorkspace}). Assets is a bottom modal sheet appended outside the frame. Returns the
 * preview canvas and its container for the render layer.
 *
 * Each panel is registered with the {@link PanelFocusTracker} so hovering it makes it the active
 * panel, and the active one wears a thin accent ring (`is-active-panel`). Panels that own editing
 * shortcuts (graph, timeline) receive the {@link HotkeyRouter} (via `context`) to register their
 * keymap.
 */

import { selectSceneCost } from "../model/selectors";
import { createAssetsModal } from "./assetsModal";
import type { EditorContext } from "./editorContext";
import { EditorPanel } from "./focus/panelFocus";
import { GraphViewState } from "./graphViewState";
import { createWorkspace } from "./layout/panelLayout";
import { createGraphPanel } from "./panels/graphPanel";
import { createPreviewPanel } from "./panels/previewPanel";
import { createTimelinePanel } from "./panels/timelinePanel";
import { createViewportObjects } from "./panels/viewportObjects";
import { createViewportStats } from "./panels/viewportStats";
import { createViewportTransform } from "./panels/viewportTransform";
import { createMiddlebar } from "./middlebar";

export interface ApplicationShell {
  readonly canvas: HTMLCanvasElement;
  readonly previewContainer: HTMLElement;
  /** Pushes fresh FPS + particle-count readings into the viewport's stats overlay (render loop). */
  readonly reportStats: (fps: number, particles: number) => void;
  /** Collapses/expands the N-panel's active tab. The viewport keymap (in main.ts) binds it to N. */
  readonly toggleTransformPanel: () => void;
  /** Opens the Content screen (assets + import/export). The global keymap (in main.ts) binds it
   *  to Ctrl+Space, alongside the middlebar's own Content button. */
  readonly openAssets: () => void;
}

export function mountApplicationShell(root: HTMLElement, context: EditorContext): ApplicationShell {
  const { store, signals, panelFocus, panelFocusTracker, previewSettings } = context;
  const graphView = new GraphViewState();

  const preview = createPreviewPanel();
  // The right-hand N-panel hosts both the Item transform and the preview view-settings tabs
  // (Lighting / Scene / Gizmo); it reads the settings + gizmo stores off the context.
  const transformPanel = createViewportTransform(context);
  preview.element.append(createViewportObjects(store));
  preview.element.append(transformPanel.element);
  const stats = createViewportStats();
  preview.element.append(stats.element);
  // Any other viewport interaction (orbit/pan/zoom/select) collapses the open N-panel tab so it
  // doesn't linger over the scene; a tab's own press/release manages its own open/close already
  // (see viewportTransform.ts), so events landing on the tab strip are left alone.
  const collapseOnViewportInteraction = (event: Event): void => {
    if (event.target instanceof Node && transformPanel.tabs.contains(event.target)) {
      return;
    }
    transformPanel.collapse();
  };
  preview.element.addEventListener("pointerdown", collapseOnViewportInteraction);
  preview.element.addEventListener("wheel", collapseOnViewportInteraction);
  // Effect cost is whole-scene and structural, unlike fps/particles (pushed every frame by the
  // render loop via reportStats) - recompute only on a source edit. A mute toggle commits as a
  // view edit (sourceViewChanged), not structural, so both are listened for.
  const updateCost = (): void => stats.reportCost(selectSceneCost(store));
  updateCost();
  signals.on("sourceStructureChanged", updateCost);
  signals.on("sourceViewChanged", updateCost);

  const graph = createGraphPanel(context, graphView);
  const timeline = createTimelinePanel(context);

  const assets = createAssetsModal(store, signals, previewSettings);
  const middlebar = createMiddlebar(context, { onOpenAssets: assets.open });
  const workspace = createWorkspace(preview.element, graph, timeline, middlebar);

  // Hovering a panel makes it active. Assets is tracked too (its open sheet covers the frame),
  // but wears no ring - the modal is already visually distinct, and its scrim spans the whole
  // screen, so a ring would frame the viewport rather than the sheet.
  panelFocusTracker.register(preview.element, EditorPanel.Viewport);
  panelFocusTracker.register(graph, EditorPanel.Graph);
  panelFocusTracker.register(timeline, EditorPanel.Timeline);
  panelFocusTracker.register(assets.element, EditorPanel.Assets);

  // The active framed panel wears the accent ring; Assets is deliberately absent (see above).
  const ringElements = new Map<EditorPanel, HTMLElement>([
    [EditorPanel.Viewport, preview.element],
    [EditorPanel.Graph, graph],
    [EditorPanel.Timeline, timeline],
  ]);
  const paintRing = (active: EditorPanel): void => {
    for (const [panel, element] of ringElements) {
      element.classList.toggle("is-active-panel", panel === active);
    }
  };
  paintRing(panelFocus.get());
  panelFocus.onChange(paintRing);

  root.append(workspace, assets.element);
  return {
    canvas: preview.canvas,
    previewContainer: preview.element,
    reportStats: stats.report,
    toggleTransformPanel: () => transformPanel.toggle(),
    openAssets: assets.open,
  };
}
