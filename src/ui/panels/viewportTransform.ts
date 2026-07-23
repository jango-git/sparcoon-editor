/**
 * The viewport's right-hand panel - Blender's N-panel in spirit: a vertical tab strip (Item, plus
 * the Lighting/Scene/Gizmo view-settings) on the preview's top-right; clicking the active tab
 * collapses the content, `N` toggles the whole panel.
 *
 * Editing a transform writes the entity's base transform (via {@link setEntityBaseChannel}), never
 * a keyframe - like the gizmo. Fields show the effective transform under the playhead.
 */

import { t } from "../../i18n";
import {
  renameEmitter,
  renameVfxMesh,
  setEntityBaseChannel,
  setProjectName,
} from "../../model/commands";
import type { SceneEntity } from "../../model/entity";
import { projectDisplayName } from "../../model/editorState";
import { selectEntityDoc } from "../../model/selectors";
import type { Store } from "../../model/store";
import { sampleTransform, IDENTITY_TRANSFORM, type Transform } from "../../model/transform";
import { NumberControl } from "../components/numberControl";
import { attachTooltip } from "../components/tooltip";
import { createElement } from "../dom";
import type { EditorContext } from "../editorContext";
import { icon, viewportIcons } from "../icons";
import { field } from "../primitives/field";
import { createPreviewSettingsGroups } from "./previewSettings";
import { channelFromDisplay, channelToDisplay } from "./transformChannel";

type Channel = "position" | "rotation" | "scale";

const AXIS_KEYS = ["axis.x", "axis.y", "axis.z"] as const;

/** The panel plus a handle to toggle it - the `N` hotkey collapses/expands the active tab. */
export interface ViewportTransformPanel {
  readonly element: HTMLElement;
  /** Collapses/expands the content beside the (always-visible) tab strip. */
  toggle(): void;
}

export function createViewportTransform(context: EditorContext): ViewportTransformPanel {
  const {
    store,
    selection,
    transport,
    signals,
    previewSettings: settings,
    gizmoSettings: gizmo,
  } = context;
  const name = document.createElement("input");
  name.type = "text";
  name.className = "viewport-transform__name";
  name.spellcheck = false;
  const commitName = (): void => {
    const entity = selection.get();
    switch (entity.kind) {
      case "vfx":
        setProjectName(store, name.value);
        return;
      case "emitter":
        renameEmitter(store, entity.id, name.value);
        return;
      case "vfxMesh":
        renameVfxMesh(store, entity.id, name.value);
        return;
    }
  };
  name.addEventListener("change", commitName);
  name.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      name.blur();
    }
  });

  const controls: Record<Channel, [NumberControl, NumberControl, NumberControl]> = {
    position: axisTriplet(
      { step: 0.05 },
      () => commit("position"),
      () => commit("position", true),
    ),
    rotation: axisTriplet(
      { step: 1, precision: 2 },
      () => commit("rotation"),
      () => commit("rotation", true),
    ),
    scale: axisTriplet(
      { step: 0.05 },
      () => commit("scale"),
      () => commit("scale", true),
    ),
  };

  // The name field is preceded by an icon of the selected object's kind, refreshed in update().
  const nameIcon = createElement("span", { className: "viewport-transform__name-icon" });
  const nameRow = createElement("div", { className: "viewport-transform__name-row" }, [
    nameIcon,
    name,
  ]);

  const itemPanel = createElement("div", { className: "viewport-transform__panel" }, [
    nameRow,
    section(t("field.position"), controls.position),
    section(t("field.rotation"), controls.rotation),
    section(t("field.scale"), controls.scale),
  ]);

  // The tab strip lives on the panel's outer (right) edge; each tab's content panel opens inward.
  // The strip is always visible, so it is the handle that reopens the panel after N collapses it.
  const tabs = createElement("div", { className: "viewport-transform__tabs" });
  const content = createElement("div", { className: "viewport-transform__content" });
  const panel = createElement("div", { className: "viewport-transform" }, [content, tabs]);
  // The open panel captures pointer/scrub gestures; keep them from reaching the orbit controls. The
  // tab strip is left to bubble, so a drag begun on it still orbits (the strip is not a dead zone).
  content.addEventListener("pointerdown", (event) => event.stopPropagation());

  // Each group is a vertical tab plus its content panel. At most one panel shows at a time; when
  // collapsed none show and no tab is highlighted (the strip stays visible either way).
  const groups: { tab: HTMLElement; panel: HTMLElement }[] = [];
  let activeIndex = 0;
  // Start collapsed: only the tab strip shows until the user opens a tab or presses N.
  let collapsed = true;

  const paint = (): void => {
    groups.forEach((group, i) => {
      const open = !collapsed && i === activeIndex;
      group.tab.classList.toggle("viewport-transform__tab--active", open);
      group.panel.classList.toggle("viewport-transform__panel--open", open);
    });
  };

  // Opening a tab; opening the already-open one collapses the content (Blender-like).
  const activateTab = (index: number): void => {
    if (!collapsed && index === activeIndex) {
      collapsed = true;
    } else {
      activeIndex = index;
      collapsed = false;
    }
    paint();
  };

  // A tab press can't rely on the browser `click`: the orbit controls' pointer-capture on the same
  // press suppresses it. Each tab records its press instead; a shared pointerup opens it only if
  // the pointer stayed within TAB_DRAG_THRESHOLD (a bigger move means it was an orbit).
  const TAB_DRAG_THRESHOLD = 4;
  let pendingTab: number | undefined;
  let tabDownX = 0;
  let tabDownY = 0;
  window.addEventListener("pointerup", (event) => {
    if (pendingTab === undefined) {
      return;
    }
    const index = pendingTab;
    pendingTab = undefined;
    if (
      Math.abs(event.clientX - tabDownX) <= TAB_DRAG_THRESHOLD &&
      Math.abs(event.clientY - tabDownY) <= TAB_DRAG_THRESHOLD
    ) {
      activateTab(index);
    }
  });
  // A cancelled gesture (e.g. pointercancel) must not leave a press pending for the next pointerup.
  window.addEventListener("pointercancel", () => {
    pendingTab = undefined;
  });

  const addTab = (
    label: string,
    glyph: string,
    description: string,
    tabPanel: HTMLElement,
  ): void => {
    const index = groups.length;
    const tab = createElement("button", {
      className: "viewport-transform__tab",
    });
    tab.type = "button";
    attachTooltip(tab, label, description);
    tab.append(
      icon(glyph),
      createElement("span", { className: "viewport-transform__tab-label", textContent: label }),
    );
    // Record the press (see the shared pointerup above); left to bubble so a drag still orbits.
    tab.addEventListener("pointerdown", (event) => {
      pendingTab = index;
      tabDownX = event.clientX;
      tabDownY = event.clientY;
    });

    tabs.append(tab);
    content.append(tabPanel);
    groups.push({ tab, panel: tabPanel });
  };

  addTab(t("viewport.item"), viewportIcons.item, t("viewport.itemTransformTip"), itemPanel);
  for (const settingsGroup of createPreviewSettingsGroups(settings, gizmo, store, signals)) {
    // The rows sit in a two-column grid (label column + control column, each uniform across the
    // tab) nested in the panel, so the panel's open/collapse display toggle stays intact.
    const grid = createElement("div", { className: "preview-settings" }, settingsGroup.rows);
    addTab(
      settingsGroup.label,
      settingsGroup.glyph,
      t("viewport.settingsTip"),
      createElement("div", { className: "viewport-transform__panel" }, [grid]),
    );
  }

  const toggle = (): void => {
    collapsed = !collapsed;
    paint();
  };
  paint();

  const read = (channel: Channel): [number, number, number] => {
    const [x, y, z] = controls[channel];
    return [x.value, y.value, z.value];
  };

  function commit(channel: Channel, live = false): void {
    setEntityBaseChannel(
      store,
      selection.get(),
      channel,
      channelFromDisplay(channel, read(channel)),
      live,
    );
  }

  function update(): void {
    const entity = selection.get();
    nameIcon.replaceChildren(icon(entityIcon(entity)));
    if (document.activeElement !== name) {
      name.value = entityName(store, entity);
    }
    const transform = effectiveTransform(store, entity, transport.getTime());
    setTriplet(controls.position, transform.position);
    setTriplet(controls.rotation, channelToDisplay("rotation", transform.rotation));
    setTriplet(controls.scale, transform.scale);
  }

  transport.subscribe(update);
  selection.subscribe(update);
  signals.on("sourceViewChanged", update);
  signals.on("sourceStructureChanged", update);
  update();

  return { element: panel, toggle };
}

function axisTriplet(
  options: { step?: number; precision?: number },
  onChange: () => void,
  live: () => void,
): [NumberControl, NumberControl, NumberControl] {
  const make = (): NumberControl => new NumberControl({ value: 0, ...options, onChange, live });
  return [make(), make(), make()];
}

function setTriplet(
  controls: [NumberControl, NumberControl, NumberControl],
  values: readonly number[],
): void {
  controls[0].setValue(values[0] ?? 0);
  controls[1].setValue(values[1] ?? 0);
  controls[2].setValue(values[2] ?? 0);
}

/** A labelled channel block with its three axis components stacked one per row. */
function section(
  label: string,
  controls: [NumberControl, NumberControl, NumberControl],
): HTMLElement {
  const componentField = (index: 0 | 1 | 2): HTMLElement =>
    field(t(AXIS_KEYS[index]), controls[index].element, {
      rowClassName: "viewport-transform__comp",
      labelClassName: "viewport-transform__axis",
    });
  return createElement("div", { className: "viewport-transform__section" }, [
    createElement("div", { className: "viewport-transform__section-title", textContent: label }),
    componentField(0),
    componentField(1),
    componentField(2),
  ]);
}

/** The badge glyph for the selected entity's kind. */
function entityIcon(entity: SceneEntity): string {
  switch (entity.kind) {
    case "vfx":
      return viewportIcons.group;
    case "emitter":
      return viewportIcons.emitter;
    case "vfxMesh":
      return viewportIcons.mesh;
  }
}

/** The selected entity's effective transform at time `time` (base or sampled animation). */
function effectiveTransform(store: Store, entity: SceneEntity, time: number): Transform {
  const doc = selectEntityDoc(store, entity);
  return doc === undefined
    ? IDENTITY_TRANSFORM
    : sampleTransform(doc.transform, doc.transformTracks, time);
}

function entityName(store: Store, entity: SceneEntity): string {
  if (entity.kind === "vfx") {
    return projectDisplayName(store.getSource().name);
  }
  const doc = selectEntityDoc(store, entity);
  return doc !== undefined && "name" in doc ? doc.name : "-";
}
