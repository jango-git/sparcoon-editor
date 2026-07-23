/**
 * The shared hover tooltip, ported from the tesselot editor: one floating card (a bold accent
 * title over an optional muted description) reused for every hover hint in the editor, so hovers
 * never leave a trail of stray elements behind. Non-interactive - it never steals the pointer.
 *
 * `attachTooltip(el, title, description?)` is the single entry point; it also mirrors the text into
 * `aria-label` so the hint is not purely visual. Prefer it over a native `title` attribute
 * everywhere, so every hover hint shares this identical look.
 */

import { createElement } from "../dom";

/** Gap (px) between the anchored element and the tooltip, and the viewport margin it keeps. */
const GAP = 8;
/** Clearance below the pointer for a pointer-anchored tooltip, so it clears the cursor arrow. */
const CURSOR_OFFSET = 18;

/**
 * Where the card is placed: at the anchor element's center (the default) or under the pointer. A
 * long timeline event is much wider than the cursor, so its hint tracks the pointer instead of
 * floating off at the element's centre.
 */
export type TooltipAnchor = "element" | "pointer";

interface TooltipContent {
  readonly title: string;
  readonly description: string;
  readonly anchor: TooltipAnchor;
}

interface PointerPosition {
  readonly x: number;
  readonly y: number;
}

// Per-element content, read live on hover - so a re-attach (e.g. a node's changing compile errors)
// just overwrites the entry instead of stacking another set of listeners.
const contentByElement = new WeakMap<HTMLElement, TooltipContent>();
const boundElements = new WeakSet<HTMLElement>();

interface TooltipElements {
  readonly element: HTMLElement;
  readonly titleElement: HTMLElement;
  readonly descriptionElement: HTMLElement;
}

let tooltipElement: HTMLElement | undefined;
let tooltipTitleElement: HTMLElement | undefined;
let tooltipDescriptionElement: HTMLElement | undefined;

// Returns all three elements together (not just the container) so callers get them
// non-null from the return type instead of re-reading the module-level variables.
function ensureTooltipElement(): TooltipElements {
  if (
    tooltipElement !== undefined &&
    tooltipTitleElement !== undefined &&
    tooltipDescriptionElement !== undefined
  ) {
    return {
      element: tooltipElement,
      titleElement: tooltipTitleElement,
      descriptionElement: tooltipDescriptionElement,
    };
  }
  tooltipTitleElement = createElement("div", { className: "tooltip__title" });
  tooltipDescriptionElement = createElement("div", { className: "tooltip__desc" });
  tooltipElement = createElement("div", { className: "tooltip" }, [
    tooltipTitleElement,
    tooltipDescriptionElement,
  ]);
  document.body.append(tooltipElement);
  return {
    element: tooltipElement,
    titleElement: tooltipTitleElement,
    descriptionElement: tooltipDescriptionElement,
  };
}

function showTooltip(
  target: HTMLElement,
  content: TooltipContent,
  pointer?: PointerPosition,
): void {
  const { element, titleElement, descriptionElement } = ensureTooltipElement();
  titleElement.textContent = content.title;
  descriptionElement.textContent = content.description;
  descriptionElement.style.display = content.description ? "" : "none";
  element.classList.add("tooltip--visible");
  positionTooltip(target, content.anchor, pointer);
}

/** Places the (already-shown) card under the pointer for a pointer anchor, else below the target. */
function positionTooltip(
  target: HTMLElement,
  anchor: TooltipAnchor,
  pointer?: PointerPosition,
): void {
  if (tooltipElement === undefined) {
    return;
  }
  const width = tooltipElement.offsetWidth;
  const height = tooltipElement.offsetHeight;
  const clampLeft = (value: number): number =>
    Math.max(GAP, Math.min(value, window.innerWidth - width - GAP));

  if (anchor === "pointer" && pointer !== undefined) {
    // Below the cursor; flip above it when that would overflow the viewport bottom.
    let top = pointer.y + CURSOR_OFFSET;
    if (top + height > window.innerHeight - GAP) {
      top = Math.max(GAP, pointer.y - height - CURSOR_OFFSET);
    }
    tooltipElement.style.left = `${clampLeft(pointer.x - width / 2)}px`;
    tooltipElement.style.top = `${top}px`;
    return;
  }

  const rectangle = target.getBoundingClientRect();
  // Default below the target; flip above when that would overflow the viewport bottom.
  let top = rectangle.bottom + GAP;
  if (top + height > window.innerHeight - GAP) {
    top = Math.max(GAP, rectangle.top - height - GAP);
  }
  tooltipElement.style.left = `${clampLeft(rectangle.left + rectangle.width / 2 - width / 2)}px`;
  tooltipElement.style.top = `${top}px`;
}

function hideTooltip(): void {
  tooltipElement?.classList.remove("tooltip--visible");
}

function bind(target: HTMLElement): void {
  if (boundElements.has(target)) {
    return;
  }
  boundElements.add(target);
  target.addEventListener("mouseenter", (event) => {
    const content = contentByElement.get(target);
    if (content !== undefined) {
      showTooltip(target, content, { x: event.clientX, y: event.clientY });
    }
  });
  // A pointer-anchored hint follows the cursor across a wide element (a long timeline event).
  target.addEventListener("mousemove", (event) => {
    const content = contentByElement.get(target);
    if (
      content?.anchor === "pointer" &&
      (tooltipElement?.classList.contains("tooltip--visible") ?? false)
    ) {
      positionTooltip(target, "pointer", { x: event.clientX, y: event.clientY });
    }
  });
  target.addEventListener("mouseleave", hideTooltip);
  target.addEventListener("pointerdown", hideTooltip);
}

/**
 * Shows the shared tooltip while `target` is hovered: a bold `title` over an optional muted
 * `description` (blank hides the description line). `anchor` places the card at the element's centre
 * (default) or under the pointer (for a wide element whose centre is far from the cursor). Also sets
 * `aria-label` so the hint reaches assistive tech, and hides on press so a click never leaves the
 * tooltip lingering. Idempotent - calling it again on the same element just updates the text.
 */
export function attachTooltip(
  target: HTMLElement,
  title: string,
  description = "",
  anchor: TooltipAnchor = "element",
): void {
  contentByElement.set(target, { title, description, anchor });
  target.setAttribute("aria-label", description ? `${title}. ${description}` : title);
  bind(target);
}

/** Removes an element's tooltip (e.g. a node whose compile errors cleared). */
export function clearTooltip(target: HTMLElement): void {
  contentByElement.delete(target);
  target.removeAttribute("aria-label");
  hideTooltip();
}
