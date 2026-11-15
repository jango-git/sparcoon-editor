/** The notice shown instead of the editor on a device it does not support. */

import { t } from "../i18n";
import { createElement } from "./dom";
import { EDITOR_REPOSITORY_URL, RUNTIME_REPOSITORY_URL } from "./repositories";

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
      createElement("nav", { className: "unsupported__links" }, [
        link(EDITOR_REPOSITORY_URL, t("unsupported.gallery")),
        link(RUNTIME_REPOSITORY_URL, t("unsupported.runtime")),
      ]),
    ]),
  );
}

function link(href: string, label: string): HTMLAnchorElement {
  return createElement("a", {
    className: "unsupported__link",
    textContent: label,
    attributes: { href, target: "_blank", rel: "noopener" },
  });
}
