/**
 * The viewport's right-hand panel - Blender's N-panel in spirit: a vertical tab strip (Item, plus
 * the Lighting/Scene/Gizmo view-settings) on the preview's top-right; `N` toggles it.
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
import { projectDisplayName } from "../../model/editorState";
import type { SceneEntity } from "../../model/entity";
import { selectEntityDoc } from "../../model/selectors";
import type { Store } from "../../model/store";
import { IDENTITY_TRANSFORM, sampleTransform, type Transform } from "../../model/transform";
import { NumberControl } from "../components/numberControl";
import { createViewportTabs, type ViewportTabs } from "../components/viewportTabs";
import { createElement } from "../dom";
import type { EditorContext } from "../editorContext";
import { icon, viewportIcons } from "../icons";
import { field } from "../primitives/field";
import { createPreviewSettingsGroups } from "./previewSettings";
import { channelFromDisplay, channelToDisplay } from "./transformChannel";

type Channel = "position" | "rotation" | "scale";

const AXIS_KEYS = ["axis.x", "axis.y", "axis.z"] as const;

/** The right-hand tabs: Item, then the view settings. The `N` hotkey toggles them. */
export function createViewportTransform(context: EditorContext): ViewportTabs {
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

  // The strip sits on the viewport's right edge; each tab's panel opens to its left.
  const tabs = createViewportTabs("right");
  tabs.addTab(t("viewport.item"), viewportIcons.item, t("viewport.itemTransformTip"), [
    nameRow,
    section(t("field.position"), controls.position),
    section(t("field.rotation"), controls.rotation),
    section(t("field.scale"), controls.scale),
  ]);
  for (const settingsGroup of createPreviewSettingsGroups(settings, gizmo, store, signals)) {
    tabs.addTab(settingsGroup.label, settingsGroup.glyph, t("viewport.settingsTip"), [
      createElement("div", { className: "preview-settings" }, settingsGroup.rows),
    ]);
  }

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

  return tabs;
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
