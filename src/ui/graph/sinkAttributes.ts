/**
 * The "add attribute" row mounted at the foot of Spawn's card only: a name field, a type picker,
 * and a confirm button. Declaring an attribute here surfaces an `attr:<name>` write slot on
 * **both** phase sinks (an attribute can be written from spawn or update), but declaring and
 * removing one is a Spawn-only action - Update just gets the resulting input row, with no remove
 * button or type picker of its own (see `graphCanvas.ts`'s `mountSinkAttributes`/`NodeView`
 * wiring). The declared attributes themselves are rendered as ordinary input rows on the sink
 * (Spawn's carrying its own remove button), so this row is only the creation control - never a
 * duplicate list of the attributes above it.
 *
 * The row is stateless: it dispatches through the handler; the canvas rebuilds the card when
 * the list changes. Pointer events are stopped from bubbling so editing never starts a node
 * drag or selection.
 */

import type { AttributeTypeName } from "../../domain/graphModel";
import { ATTRIBUTE_TYPES } from "../../domain/nodePalette";
import { createElement } from "../dom";
import { t } from "../../i18n";
import { glyphIcons, icon } from "../icons";
import { attachTooltip } from "../components/tooltip";
import { Dropdown } from "../components/dropdown";

export interface SinkAttributeHandlers {
  /** Declares a new attribute; returns `false` when the name is invalid or a duplicate. */
  readonly onAdd: (name: string, type: AttributeTypeName) => boolean;
}

function typeSelect(
  value: AttributeTypeName,
  onChange: (type: AttributeTypeName) => void,
): HTMLElement {
  const dropdown = new Dropdown({
    options: ATTRIBUTE_TYPES.map((type) => ({ value: type, label: type })),
    value,
    onChange: (next): void => onChange(next as AttributeTypeName),
  });
  dropdown.element.classList.add("attr__type");
  return dropdown.element;
}

function addRow(handlers: SinkAttributeHandlers): HTMLElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "param__input attr__new-name";
  input.placeholder = t("graph.attributePlaceholder");

  let type: AttributeTypeName = "float";
  const select = typeSelect(type, (next) => (type = next));

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

export function buildSinkAttributes(handlers: SinkAttributeHandlers): HTMLElement {
  const section = createElement("div", { className: "node__attributes" }, [addRow(handlers)]);
  // Keep field/button interaction from starting a node drag or selection.
  section.addEventListener("pointerdown", (event) => event.stopPropagation());
  return section;
}
