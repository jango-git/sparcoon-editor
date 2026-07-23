/**
 * A three-position variant of the on/off switch ({@link createSwitchControl}): the same track+thumb
 * language, but each zone carries its own icon (so every mode is visible, not just the active one)
 * and a thumb slides behind the active zone's icon to pick it out. Selectable either by clicking a
 * zone or by dragging across the track - the thumb only ever occupies one whole zone at a time (no
 * eased/continuous position), so a drag snaps between modes exactly like a click would.
 */

import type { ValueComponent } from "../primitives/component";
import { createElement } from "../dom";
import { icon } from "../icons";
import { beginPointerDrag } from "../primitives/drag";
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
    zones.forEach((zone, zoneIndex) => {
      zone.classList.toggle("tri-switch__zone--active", zoneIndex === index);
    });
  };

  const selectKey = (key: TKey): void => {
    if (current === key) {
      return;
    }
    current = key;
    paint();
    config.onChange(key);
  };

  const zones = config.options.map((option) =>
    createElement(
      "button",
      {
        className: "tri-switch__zone",
        type: "button",
        attributes: { "aria-label": option.label },
        on: { click: (): void => selectKey(option.key) },
      },
      [icon(option.glyph)],
    ),
  );

  const element = createElement("div", { className: "tri-switch" }, [...zones, thumb]);
  attachTooltip(element, config.title, config.description);

  // Dragging picks the zone under the pointer on every move, same as a click would on that zone -
  // the index is floor()'d from raw position, so it steps between whole zones, never eases.
  const zoneIndexAt = (clientX: number): number => {
    const rect = element.getBoundingClientRect();
    const relative = (clientX - rect.left) / rect.width;
    return Math.min(
      config.options.length - 1,
      Math.max(0, Math.floor(relative * config.options.length)),
    );
  };
  const selectAt = (clientX: number): void => {
    const option = config.options[zoneIndexAt(clientX)];
    if (option !== undefined) {
      selectKey(option.key);
    }
  };
  element.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    selectAt(event.clientX);
    beginPointerDrag(element, event, { onMove: (moveEvent) => selectAt(moveEvent.clientX) });
  });

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
