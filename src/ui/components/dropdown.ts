/**
 * A project-styled dropdown - the flat, sharp-cornered replacement for a native `<select>` on a
 * node (flat, monochrome, accent on hover/active).
 *
 * The trigger reads like a `.param__input` field; clicking it opens a floating menu of options
 * via the shared popover (positioned in screen space, so it is unaffected by the graph canvas's
 * pan / zoom, mirroring the add-node menu). Picking an option fires `onChange` and closes; the menu
 * also closes on an outside press, Escape, or any scroll / resize.
 *
 * `setValue` re-syncs the shown label from an external change (undo / redo), matching the
 * paramSyncer contract the node view uses for its other widgets.
 */

import { createElement } from "../dom";
import { glyphIcons, icon } from "../icons";
import type { ValueComponent } from "../primitives/component";
import { openPopover, type PopoverHandle } from "../primitives/popover";

export interface DropdownOption {
  readonly value: string;
  readonly label: string;
  /** Trailing badge shown after the label (e.g. the locale code in the language menu). */
  readonly hint?: string;
}

export interface DropdownConfig {
  readonly options: readonly DropdownOption[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Placeholder shown when the current value matches no option (e.g. an unset field). */
  readonly placeholder?: string;
  /** Lay the menu out as this many equal columns instead of a single stacked list. */
  readonly columns?: number;
  /** Accessible name for the trigger (the language switch reads its options only by badge). */
  readonly ariaLabel?: string;
  /**
   * Overrides the trigger's shown text (defaults to the selected option's label). The language
   * switch uses this to render just the locale badge on a wide-menu trigger.
   */
  readonly triggerLabel?: (option: DropdownOption | undefined, value: string) => string;
  /** Replaces the default node-field chrome (`param__input`) with middlebar-appropriate classes. */
  readonly className?: string;
  /**
   * Live zoom of a graph-node trigger's ancestor canvas, read fresh on every open so the popup's
   * rows visually match a zoomed node (see {@link PopoverOptions.scale}). Omitted outside the
   * graph (e.g. the language switch), where the popup always renders at 1x.
   */
  readonly scale?: (() => number) | undefined;
}

export class Dropdown implements ValueComponent<string> {
  public readonly element: HTMLElement;
  private readonly label: HTMLElement;
  private popover: PopoverHandle | undefined;
  private current: string;

  constructor(private readonly config: DropdownConfig) {
    this.current = config.value;
    this.label = createElement("span", { className: "dropdown__label" });
    const caret = createElement("span", { className: "dropdown__caret" }, [
      icon(glyphIcons.caretDown),
    ]);
    this.element = createElement(
      "button",
      {
        className:
          config.className !== undefined ? `dropdown ${config.className}` : "dropdown param__input",
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
      [this.label, caret],
    );
    if (config.ariaLabel !== undefined) {
      this.element.setAttribute("aria-label", config.ariaLabel);
    }
    this.syncLabel();
  }

  /** Re-syncs the displayed value from an external change without firing `onChange`. */
  public setValue(value: string): void {
    if (value === this.current) {
      return;
    }
    this.current = value;
    this.syncLabel();
  }

  public dispose(): void {
    this.popover?.close();
  }

  private syncLabel(): void {
    const option = this.config.options.find((candidate) => candidate.value === this.current);
    if (this.config.triggerLabel !== undefined) {
      this.label.textContent = this.config.triggerLabel(option, this.current);
      this.label.classList.remove("dropdown__label--placeholder");
      return;
    }
    this.label.textContent = option?.label ?? this.config.placeholder ?? this.current;
    this.label.classList.toggle("dropdown__label--placeholder", option === undefined);
  }

  private toggle(): void {
    if (this.popover !== undefined) {
      this.popover.close();
    } else {
      this.open();
    }
  }

  private open(): void {
    const columns = this.config.columns ?? 1;
    const grid = columns > 1;
    const menu = createElement("div", {
      className: grid ? "dropdown__menu dropdown__menu--grid" : "dropdown__menu",
    });
    if (grid) {
      menu.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
    }
    for (const option of this.config.options) {
      const item = createElement(
        "button",
        {
          className:
            option.value === this.current
              ? "dropdown__item dropdown__item--active"
              : "dropdown__item",
          type: "button",
          on: {
            pointerdown: (event) => event.stopPropagation(),
            click: (event) => {
              event.stopPropagation();
              this.choose(option.value);
            },
          },
        },
        [
          createElement("span", { className: "dropdown__item-label", textContent: option.label }),
          ...(option.hint !== undefined
            ? [
                createElement("span", {
                  className: "dropdown__item-hint",
                  textContent: option.hint,
                }),
              ]
            : []),
        ],
      );
      menu.append(item);
    }

    this.element.classList.add("dropdown--open");
    this.popover = openPopover(menu, {
      anchor: { rectangle: this.element.getBoundingClientRect() },
      // A single-column menu tracks the trigger width; a multi-column grid sizes to its content.
      matchAnchorWidth: !grid,
      // A single-column node menu hugs the trigger's edge (no clamp, as before); a wider grid menu
      // (the language switch, near the right edge) clamps so it never runs off-screen.
      clampToViewport: grid,
      scale: this.config.scale?.(),
      ignore: this.element,
      onDismiss: () => {
        this.popover = undefined;
        this.element.classList.remove("dropdown--open");
      },
    });
  }

  private choose(value: string): void {
    this.popover?.close();
    if (value !== this.current) {
      this.current = value;
      this.syncLabel();
      this.config.onChange(value);
    }
  }
}
