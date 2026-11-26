/**
 * A node card's width: its content's width rounded up to whole grid cells. The auto-layout places
 * cards by this width, so it must come out the same in every browser, or a graph laid out in one
 * opens with jogged wires in another. So the card is measured with each text box held to at least
 * its characters' width by `monoText.ts`, in whole pixels: a width every browser's text fits in,
 * built from the same pixel sizes everywhere. Text fields have a fixed width in CSS for the same
 * reason.
 */

import { horizontalFrame } from "../dom";
import { clamp } from "../primitives/math";
import { GRID_SIZE } from "./grid";
import { monoAdvance } from "./monoText";

/** Card width bounds in grid cells. */
const MIN_CARD_CELLS = 6;
const MAX_CARD_CELLS = 16;

/**
 * Slack (px) added to the content width before rounding up to cells. Content landing flush on a
 * cell boundary would sub-pixel-clip an `overflow: hidden` label to an ellipsis despite fitting.
 */
const CLIP_GUARD = 2;

/**
 * The card's width in px, a whole number of grid cells, or `undefined` while the card cannot be
 * measured (detached, or in a hidden panel).
 */
export function snappedCardWidth(card: HTMLElement): number | undefined {
  const natural = measureNaturalWidth(card);
  if (natural === 0) {
    return undefined;
  }
  return (
    clamp(Math.ceil((natural + CLIP_GUARD) / GRID_SIZE), MIN_CARD_CELLS, MAX_CARD_CELLS) * GRID_SIZE
  );
}

/** The card's max-content width with its text boxes held to their characters' width. */
function measureNaturalWidth(card: HTMLElement): number {
  const held: { readonly element: HTMLElement; readonly minWidth: string }[] = [];
  for (const element of card.querySelectorAll<HTMLElement>("*")) {
    const text = ownText(element);
    if (text === "") {
      continue;
    }
    const style = getComputedStyle(element);
    if (style.display === "none") {
      continue;
    }
    const advance = monoAdvance(Number.parseFloat(style.fontSize));
    held.push({ element, minWidth: element.style.minWidth });
    element.style.minWidth = `${Math.ceil([...text].length * advance + horizontalFrame(style))}px`;
  }
  const width = card.style.width;
  card.style.width = "max-content";
  const natural = card.offsetWidth;
  card.style.width = width;
  for (const { element, minWidth } of held) {
    element.style.minWidth = minWidth;
  }
  return natural;
}

/** The element's own text as laid out on one line: its text nodes, whitespace collapsed. */
function ownText(element: HTMLElement): string {
  let text = "";
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? "";
    }
  }
  return text.replace(/\s+/g, " ").trim();
}
