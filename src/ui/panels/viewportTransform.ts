/**
 * The viewport's right-hand panel - Blender's N-panel in spirit: a vertical tab strip (Item,
 * Camera, plus the Lighting/Scene/Gizmo view-settings) on the preview's top-right; `N` toggles it.
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
import type { NumberControl } from "../components/numberControl";
import { createViewportTabs, type ViewportTabs } from "../components/viewportTabs";
import { createElement } from "../dom";
import type { EditorContext } from "../editorContext";
import { icon, viewportIcons } from "../icons";
import { axisSection, axisTriplet, readTriplet, setTriplet } from "./axisFields";
import { createPreviewSettingsGroups } from "./previewSettings";
import { channelFromDisplay, channelToDisplay } from "./transformChannel";
import { createCameraTabContent } from "./viewportCameraTab";

type Channel = "position" | "rotation" | "scale";

/** The right-hand tabs: Item, Camera, then the view settings. The `N` hotkey toggles them. */
export function createViewportTransform(context: EditorContext): ViewportTabs {
  const { store, selection, transport, previewSettings: settings, gizmoSettings: gizmo } = context;
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

  const nameIcon = createElement("span", { className: "viewport-transform__name-icon" });
  const nameRow = createElement("div", { className: "viewport-transform__name-row" }, [
    nameIcon,
    name,
  ]);

  const tabs = createViewportTabs("right");
  tabs.addTab(t("viewport.item"), viewportIcons.item, t("viewport.itemTransformTip"), [
    nameRow,
    axisSection(t("field.position"), controls.position),
    axisSection(t("field.rotation"), controls.rotation),
    axisSection(t("field.scale"), controls.scale),
  ]);
  tabs.addTab(
    t("viewport.camera"),
    viewportIcons.camera,
    t("viewport.cameraTip"),
    createCameraTabContent(context.camera),
  );
  for (const settingsGroup of createPreviewSettingsGroups(settings, gizmo, store)) {
    tabs.addTab(settingsGroup.label, settingsGroup.glyph, t("viewport.settingsTip"), [
      createElement("div", { className: "preview-settings" }, settingsGroup.rows),
    ]);
  }

  const read = (channel: Channel): [number, number, number] => readTriplet(controls[channel]);

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
  store.events.sourceViewChanged.on(update);
  store.events.sourceStructureChanged.on(update);
  update();

  return tabs;
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
