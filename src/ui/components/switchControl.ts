/**
 * The editor's two-position on/off switch: the thumb parks left for off, right for on, and the
 * track lights up while on. Its width is fixed, so a switch reads as the same control wherever it
 * lands instead of stretching to its column. Use it for a setting that *is* a state; the icon
 * {@link createToggleButton} stays for controls that read as a lit-when-on action.
 */

import { createElement } from "../dom";
import { attachTooltip } from "./tooltip";

export interface SwitchControl {
  readonly element: HTMLButtonElement;
  /** Reflects an external state change into the switch without firing `onChange`. */
  set(on: boolean): void;
  get(): boolean;
}

export function createSwitchControl(options: {
  readonly title: string;
  /** Optional second tooltip line (muted), explaining what the switch does. */
  readonly description?: string;
  readonly value: boolean;
  readonly onChange: (on: boolean) => void;
}): SwitchControl {
  let on = options.value;
  // role=switch rather than a pressed button: the control carries an on/off state, not an action.
  const element = createElement(
    "button",
    { className: "switch", type: "button", attributes: { role: "switch" } },
    [createElement("span", { className: "switch__thumb" })],
  );
  // Shares the editor's hover tooltip (not a native `title`), like every other control.
  attachTooltip(element, options.title, options.description);

  const paint = (): void => {
    element.classList.toggle("switch--on", on);
    element.setAttribute("aria-checked", String(on));
  };
  paint();

  element.addEventListener("click", () => {
    on = !on;
    paint();
    options.onChange(on);
  });

  return {
    element,
    set(next: boolean): void {
      on = next;
      paint();
    },
    get(): boolean {
      return on;
    },
  };
}
