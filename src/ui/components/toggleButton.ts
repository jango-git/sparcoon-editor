/**
 * A small icon-only toggle button that replaces the editor's checkboxes: it shows a single glyph,
 * carries no label, and lights up (accent fill) while on. Clicking flips the state and reports it.
 * Defaults to `.toggle-button` / `.toggle-button--active` (the middlebar/settings-panel look), but
 * `baseClassName`/`activeClassName` let a caller with its own bespoke on-state look (e.g. the
 * timeline's dim-when-hidden mute eye, or the violet infinite-play toggle) reuse the same wiring
 * without adopting that look.
 */

import { icon } from "../icons";
import { createElement } from "../dom";
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
  // Every toggle button shares the editor's hover tooltip (not a native `title`).
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
