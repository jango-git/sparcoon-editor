/**
 * A removable/renamable row label (emitter or VFX mesh): badge + name (double-click to rename,
 * Enter/blur commits, Esc cancels) + remove button. Clicking selects (and expands) the object.
 */

import { t } from "../../i18n";
import {
  removeEmitter,
  removeVfxMesh,
  renameEmitter,
  renameVfxMesh,
  toggleEmitterHidden,
  toggleVfxMeshHidden,
} from "../../model/commands";
import type { EmitterDoc, VfxMeshDoc } from "../../model/editorState";
import type { Store } from "../../model/store";
import { attachCountdownConfirm } from "../components/countdownConfirm";
import { attachTooltip } from "../components/tooltip";
import { createToggleButton } from "../components/toggleButton";
import { createElement } from "../dom";
import { actionIcons, icon, timelineIcons, viewportIcons } from "../icons";

/** Clicks needed to confirm a row remove: three, so a stray click never deletes an object. */
const REMOVE_CLICKS = 3;

/** Actions offered on an emitter row's label (adding a spawn event at the playhead). */
export interface RowEventActions {
  readonly addBurst: () => void;
  readonly addPlay: () => void;
}

/** A small object-kind badge shown before an entity's name in its timeline row. */
export function timelineIcon(svg: string): HTMLElement {
  const wrap = createElement("span", { className: "timeline-row__icon" });
  wrap.append(icon(svg));
  return wrap;
}

/** What a removable/renamable row label needs to render and drive its rename/remove actions. */
interface RowLabelConfig {
  readonly glyph: string;
  readonly name: string;
  readonly removable: boolean;
  readonly removeLabel: string;
  readonly removeTip: string;
  readonly onSelect: () => void;
  readonly onRename: (name: string) => void;
  readonly onRemove: () => void;
  /** Emitter rows only: the add-burst / add-play buttons shown before Remove (a mesh has no events). */
  readonly eventActions?: RowEventActions;
  /** Whether the object is hidden from the outline/preview (the mute eye), and its toggle. */
  readonly hidden: boolean;
  readonly onToggleHidden: () => void;
}

/** The mute control: an eye button, always visible, swapping glyph + tint with `hidden`. */
function buildVisibilityButton(hidden: boolean, onToggle: () => void): HTMLElement {
  return createToggleButton({
    baseClassName: "timeline-row__visibility",
    activeClassName: "is-hidden",
    glyph: timelineIcons.visible,
    activeGlyph: timelineIcons.hidden,
    value: hidden,
    title: hidden ? t("timeline.showObject") : t("timeline.hideObject"),
    description: hidden ? t("timeline.showObjectTip") : t("timeline.hideObjectTip"),
    stopPropagation: true,
    onChange: onToggle,
  }).element;
}

/** A small square-bordered row-action button (add burst / play / key) with a title+description tip. */
export function rowActionButton(
  glyph: string,
  title: string,
  description: string,
  run: () => void,
): HTMLElement {
  const button = createElement("button", { className: "timeline-row__action" });
  button.type = "button";
  button.append(icon(glyph));
  attachTooltip(button, title, description);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    run();
  });
  return button;
}

function buildRowLabel(config: RowLabelConfig): HTMLElement {
  // Clicking the label selects the object, which makes it active -> its sub-rows expand.
  const name = createElement("span", {
    className: "timeline-row__name",
    textContent: config.name,
  });
  name.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    beginRename(config.name, config.onRename, name);
  });

  const children: HTMLElement[] = [timelineIcon(config.glyph), name];
  if (config.eventActions !== undefined) {
    children.push(
      rowActionButton(
        timelineIcons.burst,
        t("timeline.addBurst"),
        t("timeline.addBurstTip"),
        config.eventActions.addBurst,
      ),
      rowActionButton(
        timelineIcons.play,
        t("timeline.addPlay"),
        t("timeline.addPlayTip"),
        config.eventActions.addPlay,
      ),
    );
  }
  // The mute eye sits right before Remove, always visible (unlike the hover-only row actions), so
  // hidden objects read at a glance even on a resting timeline.
  children.push(buildVisibilityButton(config.hidden, config.onToggleHidden));
  if (config.removable) {
    // A trash button guarded by the countdown-confirm control: three clicks to remove, the button
    // counting down and reverting to the trash glyph if left idle (task 2).
    const remove = createElement("button", { className: "timeline-row__remove confirm-danger" });
    remove.type = "button";
    remove.innerHTML = actionIcons.trash;
    attachTooltip(remove, config.removeLabel, config.removeTip);
    attachCountdownConfirm(remove, actionIcons.trash, REMOVE_CLICKS, config.onRemove);
    children.push(remove);
  }

  const label = createElement("div", { className: "timeline-row__label" }, children);
  label.addEventListener("click", config.onSelect);
  return label;
}

export function buildLabel(
  store: Store,
  emitter: EmitterDoc,
  removable: boolean,
  onSelect: () => void,
  eventActions: RowEventActions,
): HTMLElement {
  return buildRowLabel({
    glyph: viewportIcons.emitter,
    name: emitter.name,
    removable,
    removeLabel: t("timeline.removeEmitter"),
    removeTip: t("timeline.removeEmitterTip"),
    onSelect,
    onRename: (name) => renameEmitter(store, emitter.id, name),
    onRemove: () => removeEmitter(store, emitter.id),
    eventActions,
    hidden: emitter.hidden === true,
    onToggleHidden: () => toggleEmitterHidden(store, emitter.id),
  });
}

export function buildMeshLabel(store: Store, mesh: VfxMeshDoc, onSelect: () => void): HTMLElement {
  return buildRowLabel({
    glyph: viewportIcons.mesh,
    name: mesh.name,
    // A scene may hold zero meshes, so a mesh is always removable (no "keep at least one" rule).
    removable: true,
    removeLabel: t("timeline.removeMesh"),
    removeTip: t("timeline.removeMeshTip"),
    onSelect,
    onRename: (name) => renameVfxMesh(store, mesh.id, name),
    onRemove: () => removeVfxMesh(store, mesh.id),
    hidden: mesh.hidden === true,
    onToggleHidden: () => toggleVfxMeshHidden(store, mesh.id),
  });
}

/** Swaps the name label for an inline text field; commits on Enter/blur, cancels on Esc. */
export function beginRename(
  current: string,
  onRename: (name: string) => void,
  nameElement: HTMLElement,
): void {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "timeline-row__rename";
  input.value = current;
  nameElement.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (save: boolean): void => {
    if (done) {
      return;
    }
    done = true;
    if (save) {
      onRename(input.value);
    } else {
      input.replaceWith(nameElement);
    }
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (event) => event.stopPropagation());
}
