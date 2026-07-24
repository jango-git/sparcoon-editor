/**
 * Add-node dialog - a floating popover opened on right-click. It has a fixed width, a search box
 * pinned to the top, its catalog items sorted by name, and a list that scrolls in whole-row steps
 * (scroll snap) so a partial row is never left showing. The list's height is a whole number of
 * rows, so the dialog itself is rounded to the row rhythm.
 *
 * Picking an item invokes the callback. It closes on pick, outside click, or Escape; typing filters
 * the list, and Enter commits the first match. Appears instantly (no animation).
 */

import { clearChildren, createElement } from "../dom";
import { t } from "../../i18n";
import { openPopover, type PopoverHandle } from "../primitives/popover";
import { helpCard } from "./helpCard";

export interface AddNodeMenuItem {
  readonly type: string;
  readonly label: string;
  /** Invisible search aliases (synonyms, enum options, category) - matched, never shown. */
  readonly tags?: readonly string[];
  /** The node's documentation, shown in a help card beside the menu on hover / highlight. */
  readonly description?: string | undefined;
}

/** Row height in px; must match `.add-node-menu__item` in graph-overlays.css for clean step scrolling. */
const ITEM_HEIGHT = 28;
/** Most rows shown before the list scrolls - caps the dialog at a whole number of rows. */
const MAX_VISIBLE_ITEMS = 10;

export class AddNodeMenu {
  public readonly element: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly list: HTMLElement;
  private items: readonly AddNodeMenuItem[] = [];
  private onPick: ((type: string) => void) | undefined = undefined;
  /** Fired once whenever an open menu closes for any reason (pick, Escape, or outside click). */
  private onClose: (() => void) | undefined = undefined;
  /** The currently shown (filtered) items, and their row buttons, parallel by index. */
  private visible: readonly AddNodeMenuItem[] = [];
  private buttons: HTMLButtonElement[] = [];
  /** The highlighted row - driven by Up/Down and by hover; Enter commits it. */
  private highlight = 0;
  /** The live popover (body placement + outside/Escape dismiss) while open; undefined when closed. */
  private handle: PopoverHandle | undefined = undefined;

  constructor() {
    this.element = createElement("div", { className: "add-node-menu" });

    this.search = document.createElement("input");
    this.search.type = "text";
    this.search.className = "add-node-menu__search";
    this.search.placeholder = t("search.placeholder");

    this.list = createElement("div", { className: "add-node-menu__list" });
    this.element.append(this.search, this.list);

    // Step the wheel one row at a time so the list never scrolls to a partial row.
    this.list.addEventListener(
      "wheel",
      (event) => {
        if (event.deltaY === 0) {
          return;
        }
        event.preventDefault();
        const direction = event.deltaY > 0 ? 1 : -1;
        const current = Math.round(this.list.scrollTop / ITEM_HEIGHT);
        this.list.scrollTop = (current + direction) * ITEM_HEIGHT;
      },
      { passive: false },
    );

    this.search.addEventListener("input", () => this.renderList());
    // Up/Down walk the list (wrapping), Enter commits the highlighted row. Keying happens while
    // the search box holds focus, so preventDefault stops Up/Down from jumping the text caret.
    this.search.addEventListener("keydown", (event) => {
      if (event.code === "ArrowDown") {
        event.preventDefault();
        this.moveHighlight(1);
      } else if (event.code === "ArrowUp") {
        event.preventDefault();
        this.moveHighlight(-1);
      } else if (event.code === "Enter") {
        event.preventDefault();
        const item = this.visible[this.highlight];
        if (item !== undefined) {
          this.pick(item.type);
        }
      }
    });
  }

  public open(
    clientX: number,
    clientY: number,
    items: readonly AddNodeMenuItem[],
    onPick: (type: string) => void,
    onClose?: () => void,
  ): void {
    this.handle?.close(); // dismiss any prior menu (firing its onClose) before adopting new state
    this.onPick = onPick;
    this.onClose = onClose;
    this.items = [...items].sort((first, second) => first.label.localeCompare(second.label));
    this.search.value = "";
    this.highlight = 0;
    this.renderList();

    // openPopover appends to the body, positions at the click point and clamps within the viewport
    // (its 8px margin matches the old inline clamp). No scroll-dismiss: the list owns the wheel for
    // its stepped scrolling, which a window wheel-dismiss would read as "view moved" and close on.
    this.handle = openPopover(this.element, {
      anchor: { x: clientX, y: clientY },
      dismissOnScroll: false,
      onDismiss: () => this.handleDismiss(),
    });
    // Re-anchor the highlighted row's help card now that the menu sits at its final position
    // (during renderList it was still detached, so its rect measured empty).
    this.setHighlight(this.highlight, false);
    this.search.focus();
  }

  public close(): void {
    // Closing the popover fires onDismiss -> handleDismiss, which does the state teardown.
    this.handle?.close();
  }

  /** State teardown when the popover is dismissed (pick, Escape, or outside press); runs once. */
  private handleDismiss(): void {
    this.handle = undefined;
    helpCard.hide();
    this.onPick = undefined;
    // Take-and-clear before calling, so a re-open triggered from the callback isn't clobbered.
    const notify = this.onClose;
    this.onClose = undefined;
    notify?.();
  }

  /**
   * Ranks the catalog against the query. A substring hit always wins (prefix highest),
   * so exact typing behaves as before; everything else falls back to a Sorensen-Dice
   * bigram similarity, so a fuzzy or slightly-misspelled query ("multipy", "veloc")
   * still surfaces the intended node, best match first.
   */
  private filtered(): readonly AddNodeMenuItem[] {
    const query = this.search.value.trim().toLowerCase();
    if (query === "") {
      return this.items;
    }
    return this.items
      .map((item) => ({ item, score: matchScore(query, item.label.toLowerCase(), item.tags) }))
      .filter((entry) => entry.score > 0)
      .sort(
        (first, second) =>
          second.score - first.score || first.item.label.localeCompare(second.item.label),
      )
      .map((entry) => entry.item);
  }

  private renderList(): void {
    clearChildren(this.list);
    this.buttons = [];
    const items = this.filtered();
    this.visible = items;

    if (items.length === 0) {
      this.list.style.maxHeight = "";
      helpCard.hide();
      this.list.append(
        createElement("div", {
          className: "add-node-menu__empty",
          textContent: this.items.length === 0 ? t("graph.noNodes") : t("search.noMatches"),
        }),
      );
      return;
    }

    // Round the visible area to a whole number of rows so no partial row shows.
    this.list.style.maxHeight = `${Math.min(items.length, MAX_VISIBLE_ITEMS) * ITEM_HEIGHT}px`;
    items.forEach((item, index) => {
      const option = createElement("button", {
        className: "add-node-menu__item",
        textContent: item.label,
      });
      option.addEventListener("click", () => this.pick(item.type));
      // Hovering a row makes it the highlighted one (so mouse and keyboard share one cursor).
      option.addEventListener("mouseenter", () => this.setHighlight(index, false));
      this.buttons.push(option);
      this.list.append(option);
    });
    // A filter edit can shrink the list from under the highlight; clamp it back into range.
    this.setHighlight(Math.min(this.highlight, items.length - 1), true);
  }

  /** Moves the highlight by `delta` rows, wrapping around the ends. */
  private moveHighlight(delta: number): void {
    const count = this.visible.length;
    if (count === 0) {
      return;
    }
    this.setHighlight((this.highlight + delta + count) % count, true);
  }

  /**
   * Highlights row `index`: repaints the active class, refreshes the help card for that item and,
   * for a keyboard move, scrolls the row into view (a hover already sits under the pointer).
   */
  private setHighlight(index: number, scroll: boolean): void {
    this.highlight = index;
    this.buttons.forEach((button, i) => {
      button.classList.toggle("add-node-menu__item--active", i === index);
    });
    const item = this.visible[index];
    if (item === undefined) {
      helpCard.hide();
      return;
    }
    if (scroll) {
      this.buttons[index]?.scrollIntoView({ block: "nearest" });
    }
    helpCard.show(this.element.getBoundingClientRect(), item.label, item.description ?? "");
  }

  private pick(type: string): void {
    const pick = this.onPick;
    this.close();
    pick?.(type);
  }
}

/** Below this Dice similarity a fuzzy match is treated as noise and dropped. */
const FUZZY_THRESHOLD = 0.34;

/**
 * A ranking score for a catalog item against `query`. Visible-label substring hits dominate
 * (a prefix beats a mid-string hit); an exact/substring hit on an invisible {@link tags} alias
 * ranks just below those (so a typed synonym like "swirl" or "+" surfaces its node without
 * outranking a real label match); the Dice bigram similarity is the last resort, kept only when
 * it clears {@link FUZZY_THRESHOLD}. `0` means "not a match".
 */
function matchScore(query: string, label: string, tags: readonly string[] = []): number {
  if (label.startsWith(query)) {
    return 4;
  }
  if (label.includes(query)) {
    return 3;
  }
  for (const tag of tags) {
    if (tag === query) {
      return 2.5;
    }
    if (tag.includes(query)) {
      return 2;
    }
  }
  const words = label.split(/\s+/);
  let best = diceSimilarity(query, label);
  for (const word of words) {
    best = Math.max(best, diceSimilarity(query, word));
  }
  return best >= FUZZY_THRESHOLD ? best : 0;
}

/** Adjacent-character bigrams of a string: `"night"` -> `["ni","ig","gh","ht"]`. */
function bigrams(value: string): readonly string[] {
  const pairs: string[] = [];
  for (let index = 0; index < value.length - 1; index += 1) {
    pairs.push(value.slice(index, index + 2));
  }
  return pairs;
}

/**
 * Sorensen-Dice coefficient over character bigrams: `2*|A intersect B| / (|A|+|B|)`, in `[0, 1]`.
 * A robust "percent of shared adjacent-letter pairs" that tolerates typos and reordering.
 */
function diceSimilarity(first: string, second: string): number {
  if (first === second) {
    return 1;
  }
  const left = bigrams(first);
  const right = bigrams(second);
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const counts = new Map<string, number>();
  for (const pair of left) {
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  let intersection = 0;
  for (const pair of right) {
    const remaining = counts.get(pair) ?? 0;
    if (remaining > 0) {
      counts.set(pair, remaining - 1);
      intersection += 1;
    }
  }
  return (2 * intersection) / (left.length + right.length);
}
