/**
 * Preview region: the live 3D viewport. Owns only the canvas element - the render layer attaches
 * the WebGL renderer to it. The dotted stage-grid CSS on `.preview` is a fallback background;
 * the opaque canvas covers it once the renderer starts drawing.
 */

import type { FXGLSLRenderTier } from "../../engine/render/compiler/FXRenderCompilers";
import { t } from "../../i18n";
import { detectRenderBackend, setRenderBackend } from "../../settings/renderBackend";
import { attachTooltip } from "../components/tooltip";
import { createElement } from "../dom";
import { icon, renderBackendIcons } from "../icons";

export interface PreviewPanel {
  readonly element: HTMLElement;
  readonly canvas: HTMLCanvasElement;
}

export function createPreviewPanel(): PreviewPanel {
  const canvas = createElement("canvas", { className: "preview__canvas" });
  const element = createElement("div", { className: "preview" }, [
    canvas,
    createRenderBackendSwitch(),
  ]);
  return { element, canvas };
}

/**
 * The floating Baseline/Standard switch in the viewport's top-left corner: picks which GLSL
 * tier (and, for `baseline`, which literal WebGL context) the preview renders with. Reload-based
 * (see `settings/renderBackend.ts`) - clicking the inactive option persists the choice and
 * reloads, it does not swap anything live.
 */
function createRenderBackendSwitch(): HTMLElement {
  const active = detectRenderBackend();

  const build = (
    tier: FXGLSLRenderTier,
    svg: string,
    label: string,
    description: string,
  ): HTMLButtonElement => {
    const button = createElement("button", { className: "graph-switch__button" });
    button.type = "button";
    button.append(icon(svg), createElement("span", { textContent: label }));
    button.classList.toggle("graph-switch__button--active", tier === active);
    button.addEventListener("click", () => setRenderBackend(tier));
    // The button captures its own click; keep it from reaching the orbit controls beneath
    // (bound to the whole preview container, per sceneCoordinator.ts).
    button.addEventListener("pointerdown", (event) => event.stopPropagation());
    attachTooltip(button, label, description);
    return button;
  };

  return createElement("div", { className: "graph-switch graph-switch--floating" }, [
    build(
      "baseline",
      renderBackendIcons.baseline,
      t("preview.renderBackendBaseline"),
      t("preview.renderBackendBaselineTip"),
    ),
    build(
      "standard",
      renderBackendIcons.standard,
      t("preview.renderBackendStandard"),
      t("preview.renderBackendStandardTip"),
    ),
  ]);
}
