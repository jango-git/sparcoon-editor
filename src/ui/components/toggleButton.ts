/**
 * Icon toggle button, accent fill while on. `baseClassName` and `activeClassName` override the
 * default look.
 */

import { createElement } from "../dom";
import { icon } from "../icons";
import { attachTooltip } from "./tooltip";

export interface ToggleButton {
  readonly element: HTMLButtonElement;
  /** Reflects an external state change into the button without firing `onChange`. */
  set(on: boolean): void;
  get(): boolean;
}

export function createToggleButton(options: {
  readonly glyph: string;
  /** Swapped in while on, for controls where the shape itself changes (e.g. open/slashed eye). */
  readonly activeGlyph?: string;
  readonly title: string;
  /** Optional second tooltip line (muted), explaining what the toggle does. */
  readonly description?: string;
  readonly value: boolean;
  readonly onChange: (on: boolean) => void;
  /** Extra class(es) for size/context variants (e.g. `"toggle-button--lg"` on the middlebar). */
  readonly className?: string;
  /** Overrides the root class; defaults to `"toggle-button"`. */
  readonly baseClassName?: string;
  /** Overrides the class toggled while on; defaults to `"<baseClassName>--active"`. */
  readonly activeClassName?: string;
  /** Stops the click from bubbling - needed when the toggle sits inside a clickable row. */
  readonly stopPropagation?: boolean;
}): ToggleButton {
  let on = options.value;
  const base = options.baseClassName ?? "toggle-button";
  const activeClassName = options.activeClassName ?? `${base}--active`;
  const className = options.className ?? "";
  const button = createElement("button", {
    className: className !== "" ? `${base} ${className}` : base,
  });
  button.type = "button";
  attachTooltip(button, options.title, options.description);

  const paint = (): void => {
    button.classList.toggle(activeClassName, on);
    button.setAttribute("aria-pressed", String(on));
    if (options.activeGlyph !== undefined) {
      button.replaceChildren(icon(on ? options.activeGlyph : options.glyph));
    }
  };
  if (options.activeGlyph === undefined) {
    button.append(icon(options.glyph));
  }
  paint();

  button.addEventListener("click", (event) => {
    if (options.stopPropagation === true) {
      event.stopPropagation();
    }
    on = !on;
    paint();
    options.onChange(on);
  });

  return {
    element: button,
    set(next: boolean): void {
      on = next;
      paint();
    },
    get(): boolean {
      return on;
    },
  };
}
