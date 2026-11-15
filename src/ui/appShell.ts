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

import type { GraphName } from "../model/graphSlots";
import { selectSceneCost } from "../model/selectors";
import type { ParticleOverflow } from "../render/sceneEmitters";
import { createAssetsModal } from "./assetsModal";
import type { EditorContext } from "./editorContext";
import { EditorPanel } from "./focus/panelFocus";
import { graphModeFor, GraphViewState } from "./graphViewState";
import { createWorkspace } from "./layout/panelLayout";
import { createMiddlebar } from "./middlebar";
import { createGraphPanel } from "./panels/graphPanel";
import { createOverdrawLegend } from "./panels/overdrawLegend";
import { createPreviewPanel } from "./panels/previewPanel";
import { createTimelinePanel } from "./panels/timelinePanel";
import { createViewportObjects } from "./panels/viewportObjects";
import { createViewportStats } from "./panels/viewportStats";
import { createViewportTransform } from "./panels/viewportTransform";
import { createViewportView } from "./panels/viewportView";

export interface ApplicationShell {
  readonly canvas: HTMLCanvasElement;
  readonly previewContainer: HTMLElement;
  /** Pushes fresh FPS, particle-count and overflow readings into the viewport's stats overlay
   *  (render loop); `overflow` is `undefined` when no emitter can report it. */
  readonly reportStats: (fps: number, particles: number, overflow?: ParticleOverflow) => void;
  /** Pushes the overdraw under the pointer into the stats overlay (render loop, overdraw view). */
  readonly reportOverdraw: (layers: number | undefined) => void;
  /** Collapses/expands the N-panel's active tab. The viewport keymap (in main.ts) binds it to N. */
  readonly toggleTransformPanel: () => void;
  /** Opens the Content screen (assets + import/export). The global keymap (in main.ts) binds it
   *  to Ctrl+Space, alongside the middlebar's own Content button. */
  readonly openAssets: () => void;
  /** Shows the active owner's graph `name` and auto-arranges it (the graph's Arrange button). */
  readonly arrangeGraph: (name: GraphName) => void;
}

export function mountApplicationShell(root: HTMLElement, context: EditorContext): ApplicationShell {
  const { store, panelFocus, panelFocusTracker } = context;
  const graphView = new GraphViewState();

  const preview = createPreviewPanel();
  // The right-hand N-panel hosts both the Item transform and the preview view-settings tabs
  // (Lighting / Scene / Gizmo); the left-hand one the Render and Overdraw tabs.
  const transformPanel = createViewportTransform(context);
  const viewPanel = createViewportView(context.viewMode);
  const stats = createViewportStats(context.viewMode);
  preview.element.append(
    viewPanel.element,
    createOverdrawLegend(context.viewMode),
    createViewportObjects(store),
    transformPanel.element,
    stats.element,
  );
  transformPanel.collapseOnInteraction(preview.element);
  viewPanel.collapseOnInteraction(preview.element);
  // Effect cost is whole-scene and structural, unlike fps/particles (pushed every frame by the
  // render loop via reportStats) - recompute only on a source edit. A mute toggle commits as a
  // view edit (sourceViewChanged), not structural, so both are listened for.
  const updateCost = (): void => stats.reportCost(selectSceneCost(store));
  updateCost();
  store.events.sourceStructureChanged.on(updateCost);
  store.events.sourceViewChanged.on(updateCost);

  const graphPanel = createGraphPanel(context, graphView);
  const graph = graphPanel.element;
  const timeline = createTimelinePanel(context);

  const assets = createAssetsModal(context);
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
    reportOverdraw: stats.reportOverdraw,
    toggleTransformPanel: () => transformPanel.toggle(),
    openAssets: assets.open,
    arrangeGraph: (name) => graphPanel.arrange(graphModeFor(name)),
  };
}
