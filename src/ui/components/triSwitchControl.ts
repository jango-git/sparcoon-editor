/**
 * A three-position variant of the on/off switch ({@link createSwitchControl}): the same track+thumb
 * language, but the thumb sits over one of three fixed zones and carries an icon naming which one -
 * unlike on/off, left/center/right position alone doesn't read as unambiguously as two states do.
 */

import type { ValueComponent } from "../primitives/component";
import { createElement } from "../dom";
import { icon } from "../icons";
import { attachTooltip } from "./tooltip";

export interface TriSwitchOption<TKey extends string> {
  readonly key: TKey;
  readonly glyph: string;
  /** Accessible name for this zone's button only - no visible label or per-zone tooltip; the whole
   *  control shares one combined tooltip (`title`/`description` below). */
  readonly label: string;
}

export function createTriSwitchControl<TKey extends string>(config: {
  readonly options: readonly [TriSwitchOption<TKey>, TriSwitchOption<TKey>, TriSwitchOption<TKey>];
  readonly title: string;
  readonly description?: string;
  readonly value: TKey;
  readonly onChange: (key: TKey) => void;
}): ValueComponent<TKey> {
  let current = config.value;
  const thumb = createElement("span", { className: "tri-switch__thumb" });

  const paint = (): void => {
    const index = Math.max(
      0,
      config.options.findIndex((option) => option.key === current),
    );
    thumb.style.setProperty("--tri-switch-index", String(index));
    thumb.replaceChildren(icon((config.options[index] ?? config.options[0]).glyph));
  };

  const zones = config.options.map((option) =>
    createElement("button", {
      className: "tri-switch__zone",
      type: "button",
      attributes: { "aria-label": option.label },
      on: {
        click: (): void => {
          if (current === option.key) {
            return;
          }
          current = option.key;
          paint();
          config.onChange(option.key);
        },
      },
    }),
  );

  const element = createElement("div", { className: "tri-switch" }, [...zones, thumb]);
  attachTooltip(element, config.title, config.description);
  paint();

  return {
    element,
    setValue(key: TKey): void {
      current = key;
      paint();
    },
    dispose(): void {},
  };
}
