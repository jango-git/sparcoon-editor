/**
 * Add-attribute row at the foot of Spawn's card: name field, type picker, confirm button. The
 * declared attribute appears as an `attr:<name>` input on both sinks. Only Spawn can add or remove
 * one.
 */

import type { AttributeTypeName } from "../../domain/graphModel";
import { ATTRIBUTE_TYPES } from "../../domain/nodePalette";
import { t } from "../../i18n";
import { Dropdown } from "../components/dropdown";
import { attachTooltip } from "../components/tooltip";
import { createElement } from "../dom";
import { glyphIcons, icon } from "../icons";

export interface SinkAttributeHandlers {
  /** Declares a new attribute; returns `false` when the name is invalid or a duplicate. */
  readonly onAdd: (name: string, type: AttributeTypeName) => boolean;
}

function typeSelect(
  value: AttributeTypeName,
  onChange: (type: AttributeTypeName) => void,
  scale?: () => number,
): HTMLElement {
  const dropdown = new Dropdown({
    options: ATTRIBUTE_TYPES.map((type) => ({ value: type, label: type })),
    value,
    onChange: (next): void => onChange(next as AttributeTypeName),
    scale,
  });
  dropdown.element.classList.add("attr__type");
  return dropdown.element;
}

function addRow(handlers: SinkAttributeHandlers, scale?: () => number): HTMLElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "param__input attr__new-name";
  input.placeholder = t("graph.attributePlaceholder");

  let type: AttributeTypeName = "float";
  const select = typeSelect(type, (next) => (type = next), scale);

  const add = createElement("button", { className: "attr__add" }, [icon(glyphIcons.plus)]);
  attachTooltip(add, t("graph.addAttribute"), t("graph.addAttributeTip"));
  const commit = (): void => {
    if (handlers.onAdd(input.value, type)) {
      input.value = "";
      input.classList.remove("attr__new-name--invalid");
    } else {
      input.classList.add("attr__new-name--invalid");
    }
  };
  add.addEventListener("click", commit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      commit();
    }
  });
  input.addEventListener("input", () => input.classList.remove("attr__new-name--invalid"));

  return createElement("div", { className: "attr__row" }, [input, select, add]);
}

export function buildSinkAttributes(
  handlers: SinkAttributeHandlers,
  scale?: () => number,
): HTMLElement {
  const section = createElement("div", { className: "node__attributes" }, [
    addRow(handlers, scale),
  ]);
  // Do not start a node drag or selection.
  section.addEventListener("pointerdown", (event) => event.stopPropagation());
  return section;
}
