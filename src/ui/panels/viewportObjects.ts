/**
 * The viewport's add-object controls (bottom-right of the 3D preview): thin chrome, each only
 * sending a command to the model. The add command makes the new object active; main.ts's selection
 * reconciler then follows the transient selection to it, keeping the gizmo/timeline in step.
 */

import { t } from "../../i18n";
import { addEmitter, addVfxMesh } from "../../model/commands";
import type { Store } from "../../model/store";
import { attachTooltip } from "../components/tooltip";
import { createElement } from "../dom";
import { icon, viewportIcons } from "../icons";

function addButton(glyph: string, label: string, tip: string, onClick: () => void): HTMLElement {
  const button = createElement("button", {
    className: "viewport-objects__button",
  });
  button.type = "button";
  attachTooltip(button, label, tip);
  button.append(icon(glyph), createElement("span", { textContent: label }));
  button.addEventListener("click", onClick);
  // The button captures its own click; keep it from reaching the orbit controls beneath.
  button.addEventListener("pointerdown", (event) => event.stopPropagation());
  return button;
}

export function createViewportObjects(store: Store): HTMLElement {
  return createElement("div", { className: "viewport-objects" }, [
    addButton(
      viewportIcons.emitter,
      t("viewport.spawnEmitter"),
      t("viewport.addEmitterTip"),
      () => void addEmitter(store),
    ),
    addButton(
      viewportIcons.mesh,
      t("viewport.addMesh"),
      t("viewport.addMeshTip"),
      () => void addVfxMesh(store),
    ),
  ]);
}
