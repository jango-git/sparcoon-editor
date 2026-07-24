/**
 * A project-styled asset picker: chooses among a project asset library (textures, meshes, HDRI
 * environments, ...) by preview thumbnail rather than by label text alone. The trigger reads like a
 * `.param__input` field (same 20px collapsed height and caret as {@link Dropdown} and the other
 * node controls); what it opens is a search-filterable list of preview rows, not a stacked text menu.
 *
 * Selection is by the option's stable `name`, matching how the model already keys texture / mesh /
 * environment references - never by array position, which would silently drift if the library is
 * reordered or an asset renamed.
 *
 * `setValue` re-syncs the shown option from an external change (undo / redo), matching the
 * paramSyncer contract the node view uses for its other widgets.
 */

import { clearChildren, createElement } from "../dom";
import { t } from "../../i18n";
import { glyphIcons, icon } from "../icons";
import type { ValueComponent } from "../primitives/component";
import { openPopover, type PopoverHandle } from "../primitives/popover";

export interface AssetPickerOption {
  readonly name: string;
  readonly label: string;
  /** A rendered preview image (a texture's own data URL, or a baked mesh/HDRI thumbnail). */
  readonly thumbnailUrl?: string;
  /** Fallback glyph shown in place of a thumbnail (e.g. while an HDRI's async decode is pending). */
  readonly glyph?: string;
}

export interface AssetPickerConfig {
  readonly options: readonly AssetPickerOption[];
  readonly value: string;
  readonly onChange: (name: string) => void;
  /** Placeholder shown when the current value matches no option (e.g. an unset field). */
  readonly placeholder?: string;
  readonly ariaLabel?: string;
  /**
   * Live zoom of a graph-node trigger's ancestor canvas, read fresh on every open so the popup's
   * rows visually match a zoomed node (see {@link PopoverOptions.scale}). Omitted outside the
   * graph (e.g. the Lighting tab's environment preset), where the popup always renders at 1x.
   */
  readonly scale?: (() => number) | undefined;
}

/** Row height in px; must match `.asset-picker__item` in params.css for a clean scroll cap - also
 *  matches Dropdown's own `.dropdown__item` height, so the two controls' popups read as one family. */
const ITEM_HEIGHT = 24;
/** Most rows shown before the list scrolls - caps the popup at a whole number of rows. */
const MAX_VISIBLE_ITEMS = 8;
/** Popup floor width in px (unscaled) - see `open()`'s own min-width computation for why this isn't
 *  just a CSS `min-width` rule. */
const MIN_MENU_WIDTH = 160;

export class AssetPicker implements ValueComponent<string> {
  public readonly element: HTMLElement;
  private readonly swatch: HTMLElement;
  private readonly label: HTMLElement;
  private popover: PopoverHandle | undefined;
  private current: string;

  // Live only while the popup is open; torn down (set back to undefined) on dismiss.
  private search: HTMLInputElement | undefined;
  private list: HTMLElement | undefined;
  private visible: readonly AssetPickerOption[] = [];
  private buttons: HTMLButtonElement[] = [];
  /** The keyboard/mouse cursor row (Up/Down and hover share it); Enter commits it. */
  private highlight = 0;
  /** The zoom this popup opened at - `renderList`'s own max-height math must agree with
   *  `.asset-picker__item`'s CSS height (`calc(ITEM_HEIGHT * var(--popup-scale))`), or the list
   *  caps its visible area at the unzoomed row height while rows render at the zoomed one. */
  private currentScale = 1;

  constructor(private readonly config: AssetPickerConfig) {
    this.current = config.value;
    this.swatch = createElement("span", { className: "asset-picker__swatch" });
    this.label = createElement("span", { className: "asset-picker__label" });
    const caret = createElement("span", { className: "asset-picker__caret" }, [
      icon(glyphIcons.caretDown),
    ]);
    this.element = createElement(
      "button",
      {
        className: "asset-picker param__input",
        type: "button",
        on: {
          click: (event) => {
            event.stopPropagation();
            this.toggle();
          },
          // Keep a press on the trigger from starting a node drag / marquee.
          pointerdown: (event) => event.stopPropagation(),
        },
      },
      [this.swatch, this.label, caret],
    );
    if (config.ariaLabel !== undefined) {
      this.element.setAttribute("aria-label", config.ariaLabel);
    }
    this.sync();
  }

  /** Re-syncs the displayed value from an external change without firing `onChange`. */
  public setValue(value: string): void {
    if (value === this.current) {
      return;
    }
    this.current = value;
    this.sync();
  }

  /**
   * Re-paints the trigger (and, if it's currently open, the popup's own rows) from the current
   * option list even if the selected value itself hasn't changed - `setValue`'s no-op-when-
   * unchanged guard would otherwise miss an option's own thumbnail/label arriving or changing in
   * place (e.g. an HDRI's async decode landing after this picker already shows that asset, or is
   * already open showing it, as selected).
   */
  public refresh(): void {
    this.sync();
    if (this.list !== undefined) {
      this.renderList();
    }
  }

  public dispose(): void {
    this.popover?.close();
  }

  private currentOption(): AssetPickerOption | undefined {
    return this.config.options.find((candidate) => candidate.name === this.current);
  }

  private sync(): void {
    const option = this.currentOption();
    this.label.textContent = option?.label ?? this.config.placeholder ?? this.current;
    this.label.classList.toggle("asset-picker__label--placeholder", option === undefined);
    paintSwatch(this.swatch, option);
  }

  private toggle(): void {
    if (this.popover !== undefined) {
      this.popover.close();
    } else {
      this.open();
    }
  }

  private open(): void {
    // Snapshot once: renderList's max-height math and openPopover's --popup-scale must agree on
    // the same number, not each read the live getter separately.
    this.currentScale = this.config.scale?.() ?? 1;
    const anchorRect = this.element.getBoundingClientRect();
    const menu = createElement("div", { className: "asset-picker__menu" });
    // At least as wide as the trigger it hangs from, so it never reads as narrower OR gratuitously
    // wider - a bare `<input>`'s own browser-default preferred width can otherwise inflate a
    // shrink-to-fit popup past a comfortably wide trigger for no content-driven reason (not
    // openPopover's matchAnchorWidth: that sets a plain inline min-width, which would floor a
    // narrower trigger below MIN_MENU_WIDTH instead of combining the two).
    menu.style.minWidth = `${Math.max(MIN_MENU_WIDTH * this.currentScale, anchorRect.width)}px`;
    const search = document.createElement("input");
    search.type = "text";
    search.className = "asset-picker__search";
    search.placeholder = t("search.placeholder");
    const list = createElement("div", { className: "asset-picker__list" });
    menu.append(search, list);
    this.search = search;
    this.list = list;
    this.highlight = 0;

    search.addEventListener("input", () => this.renderList());
    // Up/Down walk the list (wrapping), Enter commits the highlighted row - mirrors the graph's
    // add-node search (addNodeMenu.ts). preventDefault stops Up/Down from moving the text caret.
    search.addEventListener("keydown", (event) => {
      if (event.code === "ArrowDown") {
        event.preventDefault();
        this.moveHighlight(1);
      } else if (event.code === "ArrowUp") {
        event.preventDefault();
        this.moveHighlight(-1);
      } else if (event.code === "Enter") {
        event.preventDefault();
        const option = this.visible[this.highlight];
        if (option !== undefined) {
          this.choose(option.name);
        }
      }
    });
    // Keep a press anywhere in the popup (the search box included) from starting a node drag.
    menu.addEventListener("pointerdown", (event) => event.stopPropagation());

    this.renderList();

    this.element.classList.add("asset-picker--open");
    this.popover = openPopover(menu, {
      anchor: { rectangle: anchorRect },
      clampToViewport: true,
      scale: this.currentScale,
      ignore: this.element,
      onDismiss: () => {
        this.popover = undefined;
        this.search = undefined;
        this.list = undefined;
        this.element.classList.remove("asset-picker--open");
      },
    });
    search.focus();
  }

  /**
   * Ranks the library against the query: a label prefix wins outright, then a mid-label substring,
   * then a Sorensen-Dice bigram similarity as a fuzzy fallback (so "wodo" still finds "Wood") -
   * the same tiering as the graph's add-node search, minus its tag-alias tier (an asset has no
   * synonym vocabulary to match against).
   */
  private filtered(): readonly AssetPickerOption[] {
    const query = this.search?.value.trim().toLowerCase() ?? "";
    if (query === "") {
      return this.config.options;
    }
    return this.config.options
      .map((option) => ({ option, score: matchScore(query, option.label.toLowerCase()) }))
      .filter((entry) => entry.score > 0)
      .sort(
        (first, second) =>
          second.score - first.score || first.option.label.localeCompare(second.option.label),
      )
      .map((entry) => entry.option);
  }

  private renderList(): void {
    const list = this.list;
    if (list === undefined) {
      return;
    }
    clearChildren(list);
    this.buttons = [];
    const options = this.filtered();
    this.visible = options;

    if (options.length === 0) {
      list.style.maxHeight = "";
      list.append(
        createElement("div", {
          className: "asset-picker__empty",
          textContent: t("search.noMatches"),
        }),
      );
      return;
    }

    // Round the visible area to a whole number of rows so no partial row shows; scaled by the same
    // factor as .asset-picker__item's own CSS height, or a zoomed row would render taller than the
    // area this caps it to.
    list.style.maxHeight = `${Math.min(options.length, MAX_VISIBLE_ITEMS) * ITEM_HEIGHT * this.currentScale}px`;
    options.forEach((option, index) => {
      const preview = createElement("span", { className: "asset-picker__item-preview" });
      paintSwatch(preview, option);
      const item = createElement(
        "button",
        {
          className: "asset-picker__item",
          type: "button",
          on: {
            click: (event) => {
              event.stopPropagation();
              this.choose(option.name);
            },
            // Hovering a row makes it the highlighted one (so mouse and keyboard share one cursor).
            mouseenter: () => this.setHighlight(index, false),
          },
        },
        [
          preview,
          createElement("span", {
            className: "asset-picker__item-label",
            textContent: option.label,
          }),
        ],
      );
      if (option.name === this.current) {
        item.classList.add("asset-picker__item--selected");
      }
      this.buttons.push(item);
      list.append(item);
    });
    // A filter edit can shrink the list from under the highlight; clamp it back into range.
    this.setHighlight(Math.min(this.highlight, options.length - 1), true);
  }

  /** Moves the highlight by `delta` rows, wrapping around the ends. */
  private moveHighlight(delta: number): void {
    const count = this.visible.length;
    if (count === 0) {
      return;
    }
    this.setHighlight((this.highlight + delta + count) % count, true);
  }

  /** Highlights row `index`; for a keyboard move, scrolls it into view (a hover is already visible). */
  private setHighlight(index: number, scroll: boolean): void {
    this.highlight = index;
    this.buttons.forEach((button, i) => {
      button.classList.toggle("asset-picker__item--highlight", i === index);
    });
    if (scroll) {
      this.buttons[index]?.scrollIntoView({ block: "nearest" });
    }
  }

  private choose(name: string): void {
    this.popover?.close();
    if (name !== this.current) {
      this.current = name;
      this.sync();
      this.config.onChange(name);
    }
  }
}

/** Fills a preview well with the option's thumbnail image, its fallback glyph, or (matching an
 *  unset/unknown value) nothing but the well's own empty background. */
function paintSwatch(well: HTMLElement, option: AssetPickerOption | undefined): void {
  clearChildren(well);
  if (option?.thumbnailUrl !== undefined) {
    const thumbnail = document.createElement("img");
    thumbnail.className = "asset-picker__thumb";
    thumbnail.src = option.thumbnailUrl;
    thumbnail.alt = option.label;
    thumbnail.draggable = false;
    well.append(thumbnail);
  } else if (option?.glyph !== undefined) {
    well.append(icon(option.glyph));
  }
}

/** Below this Dice similarity a fuzzy match is treated as noise and dropped. */
const FUZZY_THRESHOLD = 0.34;

function matchScore(query: string, label: string): number {
  if (label.startsWith(query)) {
    return 4;
  }
  if (label.includes(query)) {
    return 3;
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
