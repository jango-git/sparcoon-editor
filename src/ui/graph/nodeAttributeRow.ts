import type { GraphNode } from "../../domain/graphModel";
import type { AttributeTypeName } from "../../domain/graphModel";
import { ATTRIBUTE_TYPES } from "../../domain/nodePalette";
import { t } from "../../i18n";
import { createElement } from "../dom";
import { actionIcons } from "../icons";
import { attachCountdownConfirm } from "../components/countdownConfirm";
import { attachTooltip } from "../components/tooltip";
import { Dropdown } from "../components/dropdown";
import type { NodeRow } from "./nodeGrid";
import type { NodeWidgets } from "./nodeWidgets";

/** Presses to confirm removing a declared attribute (see {@link attachCountdownConfirm}). */
const REMOVE_CLICKS = 4;

/** A selectable attribute for an attribute node's dropdown (name + element type). */
export interface AttributeOption {
  readonly name: string;
  readonly type: string;
}

/** Wiring for an attribute node (`custom-attribute`): the declared attributes + a picker. */
export interface AttributeNodeConfig {
  readonly options: readonly AttributeOption[];
  /** Chooses which attribute the node reads (a structural edit - replaces the node). */
  readonly onSelect: (name: string, type: string) => void;
}

/**
 * The trash button that removes a declared attribute, sitting at the end of its input row.
 * Guarded by the shared countdown-confirm control so a stray click never drops an attribute.
 */
export function buildAttributeRemove(name: string, onRemove: (name: string) => void): HTMLElement {
  const remove = createElement("button", { className: "attr__remove confirm-danger" });
  remove.innerHTML = actionIcons.trash;
  attachTooltip(remove, t("graph.removeAttributeTitle"), t("graph.removeAttributeTip", { name }));
  // Swallow pointerdown so clicking the button never starts a node drag or selection.
  remove.addEventListener("pointerdown", (event) => event.stopPropagation());
  attachCountdownConfirm(remove, actionIcons.trash, REMOVE_CLICKS, () => onRemove(name));
  return remove;
}

/**
 * The free-text Name field on a declared attribute's own input row (replaces the plain socket
 * label there) - renaming retargets the slot and every `custom-attribute` node reading it, so it
 * commits on blur/Enter rather than per keystroke. An invalid/duplicate name is flagged and left
 * for the user to fix rather than silently reverted, matching the "add attribute" row below.
 */
export function buildAttributeName(
  name: string,
  onRename: (oldName: string, newName: string) => boolean,
): HTMLElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "param__input attr__name";
  input.value = name;
  // Swallow pointerdown so editing the name never starts a node drag or selection.
  input.addEventListener("pointerdown", (event) => event.stopPropagation());
  input.addEventListener("input", () => input.classList.remove("attr__name--invalid"));
  input.addEventListener("change", () => {
    if (onRename(name, input.value)) {
      input.classList.remove("attr__name--invalid");
    } else {
      input.classList.add("attr__name--invalid");
    }
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      input.blur();
    }
  });
  return input;
}

/**
 * The element-type dropdown on a declared attribute's row. Changing it retypes the attribute
 * in place (a structural edit that recompiles) - the counterpart of the add row's type picker.
 */
export function buildAttributeType(
  name: string,
  currentType: string,
  onSetType: (name: string, type: AttributeTypeName) => void,
  scale?: () => number,
): HTMLElement {
  const dropdown = new Dropdown({
    options: ATTRIBUTE_TYPES.map((type) => ({ value: type, label: type })),
    value: currentType,
    onChange: (next): void => onSetType(name, next as AttributeTypeName),
    scale,
  });
  dropdown.element.classList.add("attr__type");
  // Swallow pointerdown so opening the picker never starts a node drag or selection.
  dropdown.element.addEventListener("pointerdown", (event) => event.stopPropagation());
  return dropdown.element;
}

/** The attribute picker for a `custom-attribute` node: a dropdown of the declared attributes. */
export function buildAttributeRow(
  node: GraphNode,
  config: AttributeNodeConfig,
  widgets: NodeWidgets,
  labelledRow: (label: HTMLElement, control: HTMLElement) => NodeRow,
  scale?: () => number,
): NodeRow {
  const label = createElement("span", {
    className: "param__label",
    textContent: t("graph.attribute"),
  });
  const current = String(node.parameters["name"] ?? "");

  let control: HTMLElement;
  if (config.options.length === 0) {
    control = createElement("span", {
      className: "param__placeholder",
      textContent: t("graph.declareAttribute"),
    });
  } else {
    const dropdown = new Dropdown({
      options: config.options.map((option) => ({ value: option.name, label: option.name })),
      value: current,
      placeholder: "-",
      onChange: (name): void => {
        const chosen = config.options.find((option) => option.name === name);
        if (chosen !== undefined) {
          config.onSelect(chosen.name, chosen.type);
        }
      },
      scale,
    });
    widgets.track(dropdown);
    control = dropdown.element;
  }

  return labelledRow(label, control);
}
