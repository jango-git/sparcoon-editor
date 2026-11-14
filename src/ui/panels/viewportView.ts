/**
 * The viewport's left-hand tabs: Render, which GLSL tier the preview renders with, and Overdraw,
 * whether the viewport shows the shaded frame or an overdraw count. The Overdraw tab is marked
 * while a count is on, so the state shows with the panel collapsed.
 */

import type { FXGLSLRenderTier } from "../../engine/render/compiler/FXRenderCompilers";
import { t } from "../../i18n";
import { detectRenderBackend, setRenderBackend } from "../../settings/renderBackend";
import { createSegmentedControl, type SegmentOption } from "../components/segmentedControl";
import { createViewportTabs, type ViewportTabs } from "../components/viewportTabs";
import { renderBackendIcons, viewportIcons } from "../icons";
import type { PreviewViewMode, PreviewViewModeState } from "../previewViewMode";

export function createViewportView(viewMode: PreviewViewModeState): ViewportTabs {
  const reload = t("preview.renderBackendReload");
  const backendOptions: SegmentOption<FXGLSLRenderTier>[] = [
    {
      key: "baseline",
      label: t("preview.renderBackendBaseline"),
      glyph: renderBackendIcons.baseline,
      labelled: true,
      description: `${t("preview.renderBackendBaselineTip")} ${reload}`,
    },
    {
      key: "standard",
      label: t("preview.renderBackendStandard"),
      glyph: renderBackendIcons.standard,
      labelled: true,
      description: `${t("preview.renderBackendStandardTip")} ${reload}`,
    },
  ];
  const opaque = t("preview.viewOpaqueNote");
  const modeOptions: SegmentOption<PreviewViewMode>[] = [
    {
      key: "shaded",
      label: t("preview.viewShaded"),
      glyph: viewportIcons.viewShaded,
      labelled: true,
      description: t("preview.viewShadedTip"),
    },
    {
      key: "rasterized",
      label: t("preview.viewOverdraw"),
      glyph: viewportIcons.viewOverdraw,
      labelled: true,
      description: `${t("preview.viewOverdrawTip")} ${opaque}`,
    },
    {
      key: "surviving",
      label: t("preview.viewSurviving"),
      glyph: viewportIcons.viewSurviving,
      labelled: true,
      description: `${t("preview.viewSurvivingTip")} ${opaque}`,
    },
  ];
  // The tier is fixed for the session: picking the other one stores it and reloads.
  const backend = createSegmentedControl(backendOptions, detectRenderBackend(), setRenderBackend);
  const mode = createSegmentedControl(modeOptions, viewMode.mode, (next) => viewMode.setMode(next));

  const tabs = createViewportTabs("left");
  tabs.addTab(t("viewport.render"), renderBackendIcons.standard, t("viewport.renderTip"), [
    backend.element,
  ]);
  const overdrawTab = tabs.addTab(
    t("viewport.overdraw"),
    viewportIcons.viewOverdraw,
    t("viewport.overdrawTip"),
    [mode.element],
  );
  const sync = (next: PreviewViewMode): void => {
    mode.setValue(next);
    overdrawTab.setMarked(viewMode.overdrawOn);
  };
  sync(viewMode.mode);
  viewMode.onChange(sync);
  return tabs;
}
