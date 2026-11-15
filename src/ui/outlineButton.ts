import { attachTooltip } from "./components/tooltip";
import { createElement } from "./dom";
import { icon } from "./icons";

/**
 * An outline button of an icon and a label, with a tooltip titled by the label and saying `tip`.
 * `className` places it in its surface's layout.
 */
export function outlineButton(
  glyph: string,
  label: string,
  tip: string,
  className: string,
): HTMLButtonElement {
  const button = createElement("button", {
    className: `outline-button ${className}`,
    type: "button",
  });
  button.append(icon(glyph), createElement("span", { textContent: label }));
  attachTooltip(button, label, tip);
  return button;
}

/** Changes the label of a button made by {@link outlineButton}. */
export function setOutlineLabel(button: HTMLButtonElement, label: string): void {
  const span = button.querySelector("span") ?? undefined;
  if (span !== undefined) {
    span.textContent = label;
  }
}
