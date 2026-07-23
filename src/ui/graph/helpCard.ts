/**
 * A single floating help card, shared by the two places a node's documentation surfaces: the
 * add-node menu (hovering / keyboard-highlighting an item) and a node's header help icon. It
 * shows the node's label and its engine `description`, anchored beside whatever opened it.
 *
 * One module-level instance (lazily mounted on `document.body`) is reused everywhere, so hovers
 * never leave a trail of stray panels behind. Pure chrome - it reads no model state and sends no
 * commands; callers pass in the text and an anchor rectangle.
 */

import { createElement } from "../dom";
import { clamp } from "../primitives/math";

/** Gap (px) between the anchor and the card, and the viewport margin it is kept inside. */
const GAP = 8;

/** The three DOM refs are always created and used together; bundled so one check narrows all three. */
interface HelpCardParts {
  element: HTMLElement;
  title: HTMLElement;
  body: HTMLElement;
}

class HelpCard {
  private parts: HelpCardParts | undefined;

  /**
   * Shows the card for `title`/`description`, spanning the full width of `anchor` (a node header,
   * or the add-node menu) and sitting directly above it - flipped below only when there is not
   * enough room above - then clamped within the viewport. A blank description hides the card
   * (nothing to document).
   */
  public show(anchor: DOMRect, title: string, description: string): void {
    const text = description.trim();
    if (text === "") {
      this.hide();
      return;
    }
    const { element, title: titleElement, body: bodyElement } = this.ensure();
    titleElement.textContent = title;
    bodyElement.textContent = text;

    // Match the anchor's width (capped to the viewport), measure the resulting height hidden,
    // then place above the anchor - or below it when the top would clip.
    const width = Math.min(anchor.width, window.innerWidth - GAP * 2);
    element.style.visibility = "hidden";
    element.style.display = "block";
    element.style.width = `${width}px`;
    element.style.left = "0px";
    element.style.top = "0px";
    const height = element.getBoundingClientRect().height;
    const above = anchor.top - GAP - height;
    const top = above >= GAP ? above : anchor.bottom + GAP;
    // A card taller/wider than the viewport would push max below min (GAP); floor it.
    const maxLeft = Math.max(GAP, window.innerWidth - width - GAP);
    const maxTop = Math.max(GAP, window.innerHeight - height - GAP);
    element.style.left = `${clamp(anchor.left, GAP, maxLeft)}px`;
    element.style.top = `${clamp(top, GAP, maxTop)}px`;
    element.style.visibility = "visible";
  }

  public hide(): void {
    if (this.parts !== undefined) {
      this.parts.element.style.display = "none";
    }
  }

  private ensure(): HelpCardParts {
    if (this.parts === undefined) {
      const title = createElement("div", { className: "node-help__title" });
      const body = createElement("div", { className: "node-help__body" });
      const element = createElement("div", { className: "node-help" }, [title, body]);
      element.style.display = "none";
      document.body.append(element);
      this.parts = { element, title, body };
    }
    return this.parts;
  }
}

/** The shared singleton - import and call `helpCard.show(...)` / `helpCard.hide()`. */
export const helpCard = new HelpCard();
