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
  setLiveEvents,
  toggleEmitterHidden,
  toggleVfxMeshHidden,
} from "../../model/commands";
import type { EmitterDoc, VfxMeshDoc } from "../../model/editorState";
import type { Store } from "../../model/store";
import { attachCountdownConfirm } from "../components/countdownConfirm";
import { createToggleButton } from "../components/toggleButton";
import { attachTooltip } from "../components/tooltip";
import { createElement } from "../dom";
import { actionIcons, icon, timelineIcons, viewportIcons } from "../icons";

/** Clicks needed to confirm a row remove: three, so a stray click never deletes an object. */
const REMOVE_CLICKS = 3;

/** Actions offered on an emitter row's label (adding a spawn event at the playhead, or a death
 *  reaction from a menu anchored on the button). */
export interface RowEventActions {
  readonly addBurst: () => void;
  readonly addPlay: () => void;
  readonly addReaction: (anchor: HTMLElement) => void;
  /** The names of the emitters reacting to this one's particles' deaths, in scene order. */
  readonly triggers: readonly string[];
  /** Goes to the first of them (the link shown while {@link triggers} is not empty). */
  readonly showTriggers: () => void;
}

/** A small object-kind badge shown before an entity's name in its timeline row. */
export function timelineIcon(svg: string): HTMLElement {
  const wrap = createElement("span", { className: "timeline-row__icon" });
  wrap.append(icon(svg));
  return wrap;
}

/** {@link RowEventActions} plus the emitter's live-events toggle, which the label drives itself. */
interface RowEventControls extends RowEventActions {
  readonly live: boolean;
  readonly toggleLive: () => void;
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
  /** Emitter rows only: the add-burst / add-play buttons and the live-events toggle shown before
   *  Remove (a mesh has no events). */
  readonly eventActions?: RowEventControls;
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

/**
 * The live-events toggle: the spawn events play in the editor only and the exported effect leaves
 * spawning to the host code. Lit like a track's live toggle, and shown at rest while on (see
 * timeline.css), so an emitter that will not spawn in the game reads at a glance.
 */
function buildLiveEventsToggle(live: boolean, onToggle: () => void): HTMLElement {
  const button = rowActionButton(
    timelineIcons.live,
    t(live ? "timeline.unmarkFake" : "timeline.markFake"),
    t(live ? "timeline.unmarkEventsFakeTip" : "timeline.markEventsFakeTip"),
    onToggle,
  );
  button.classList.toggle("is-live", live);
  return button;
}

/** Adds a death reaction: opens the menu of what this emitter may react to, under the button. */
function buildAddReactionButton(addReaction: (anchor: HTMLElement) => void): HTMLElement {
  const button = rowActionButton(
    timelineIcons.reaction,
    t("timeline.addReaction"),
    t("timeline.addReactionTip"),
    () => addReaction(button),
  );
  return button;
}

/**
 * The link on a death source's row: lit and shown at rest (like the live toggle), naming who
 * reacts to its particles' deaths; a click goes there.
 */
function buildTriggersLink(triggers: readonly string[], show: () => void): HTMLElement {
  const button = rowActionButton(
    timelineIcons.reaction,
    t("timeline.triggers"),
    t("timeline.triggersTip", { targets: triggers.join(", ") }),
    show,
  );
  button.classList.add("is-linked");
  return button;
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
      buildAddReactionButton(config.eventActions.addReaction),
      buildLiveEventsToggle(config.eventActions.live, config.eventActions.toggleLive),
    );
    if (config.eventActions.triggers.length > 0) {
      children.push(
        buildTriggersLink(config.eventActions.triggers, config.eventActions.showTriggers),
      );
    }
  }
  // The mute eye sits right before Remove, always visible (unlike the hover-only row actions), so
  // hidden objects read at a glance even on a resting timeline.
  children.push(buildVisibilityButton(config.hidden, config.onToggleHidden));
  if (config.removable) {
    // A trash button guarded by the countdown-confirm control: three clicks to remove, the button
    // counting down and reverting to the trash glyph if left idle.
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
    eventActions: {
      ...eventActions,
      live: emitter.liveEvents === true,
      toggleLive: () => setLiveEvents(store, emitter.id, emitter.liveEvents !== true),
    },
    hidden: emitter.hidden === true,
    onToggleHidden: () => toggleEmitterHidden(store, emitter.id),
  });
}

export function buildMeshLabel(
  store: Store,
  mesh: VfxMeshDoc,
  removable: boolean,
  onSelect: () => void,
): HTMLElement {
  return buildRowLabel({
    glyph: viewportIcons.mesh,
    name: mesh.name,
    removable,
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
