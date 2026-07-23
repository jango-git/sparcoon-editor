/**
 * Segmented control - the editor's "tabs". Adjacent segments overlap borders by 1px to read as one
 * strip; the active segment raises its own accent border above its neighbours.
 *
 * A {@link ValueComponent} like the other value editors: `setValue` re-syncs the active segment from
 * external state without firing `onChange`. `dispose` is a no-op (listeners sit on the strip's own
 * buttons and GC with it) but honours the contract so owners can tear every control down uniformly.
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
  /** Second (muted) tooltip line - what this option does. Shown on icon segments. */
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

  const createButton = (option: SegmentOption<TKey>): HTMLButtonElement => {
    const glyph = option.glyph ?? "";
    const button =
      glyph !== ""
        ? createElement("button", { className: "segment segment--icon" })
        : createElement("button", { className: "segment", textContent: option.label });
    if (glyph !== "") {
      button.append(icon(glyph));
      attachTooltip(button, option.label, option.description);
    }
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
