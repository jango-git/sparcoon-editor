/**
 * Segmented control. Adjacent segments overlap borders by 1px. `setValue` re-syncs without firing
 * `onChange`. `dispose` is a no-op.
 */

import { createElement } from "../dom";
import { icon } from "../icons";
import type { ValueComponent } from "../primitives/component";
import { attachTooltip } from "./tooltip";

export interface SegmentOption<TKey extends string> {
  readonly key: TKey;
  readonly label: string;
  /** An icon segment: renders this glyph instead of the label text, with `label` as its tooltip. */
  readonly glyph?: string;
  /** Keeps the label text beside the glyph, for options whose glyph alone is no common symbol. */
  readonly labelled?: boolean;
  /** Second (muted) tooltip line - what this option does. An icon segment always has a tooltip, a
   *  text one only with this. */
  readonly description?: string;
}

export function createSegmentedControl<TKey extends string>(
  options: readonly SegmentOption<TKey>[],
  activeKey: TKey,
  onChange: (key: TKey) => void,
): ValueComponent<TKey> {
  const group = createElement("div", { className: "segment-group" });
  let current = activeKey;

  const buttons = new Map<TKey, HTMLButtonElement>();
  const refresh = (): void => {
    for (const [key, button] of buttons) {
      button.classList.toggle("segment--active", key === current);
    }
  };

  const createFace = (option: SegmentOption<TKey>): HTMLButtonElement => {
    const glyph = option.glyph ?? "";
    if (glyph === "") {
      const button = createElement("button", { className: "segment", textContent: option.label });
      if (option.description !== undefined) {
        attachTooltip(button, option.label, option.description);
      }
      return button;
    }
    const labelled = option.labelled === true;
    const button = createElement("button", {
      className: labelled ? "segment segment--labelled" : "segment segment--icon",
    });
    button.append(icon(glyph));
    if (labelled) {
      button.append(createElement("span", { textContent: option.label }));
    }
    attachTooltip(button, option.label, option.description);
    return button;
  };

  const createButton = (option: SegmentOption<TKey>): HTMLButtonElement => {
    const button = createFace(option);
    button.addEventListener("click", () => {
      if (current === option.key) {
        return;
      }
      current = option.key;
      refresh();
      onChange(option.key);
    });
    return button;
  };

  for (const option of options) {
    const button = createButton(option);
    buttons.set(option.key, button);
    group.append(button);
  }

  refresh();
  return {
    element: group,
    setValue(key: TKey): void {
      current = key;
      refresh();
    },
    dispose(): void {},
  };
}
