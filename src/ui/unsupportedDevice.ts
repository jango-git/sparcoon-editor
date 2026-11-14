/** The notice shown instead of the editor on a device it does not support. */

import { t } from "../i18n";
import { createElement } from "./dom";

/** Whether any input is a mouse, trackpad or similar. A touch-only phone or tablet has none; an
 *  iPad with a trackpad or a touchscreen laptop does. Browsers without `matchMedia` pass. */
export function hasPrecisePointer(): boolean {
  if (typeof window.matchMedia !== "function") {
    return true;
  }
  return window.matchMedia("(any-pointer: fine)").matches;
}

export function mountUnsupportedDevice(root: HTMLElement): void {
  root.replaceChildren(
    createElement("main", { className: "unsupported" }, [
      createElement("img", {
        className: "unsupported__logo",
        attributes: { src: "./assets/logo.svg", alt: "" },
      }),
      createElement("h1", { className: "unsupported__title", textContent: t("unsupported.title") }),
      createElement("p", { className: "unsupported__text", textContent: t("unsupported.text") }),
    ]),
  );
}
