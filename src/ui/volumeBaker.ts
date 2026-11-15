/**
 * The SDF baker: a screen of the Content sheet, in place of its blocks, that bakes a mesh asset into
 * a volume asset. The 3D view of the bake fills the left side, the settings take the right, and
 * what belongs to the view alone sits over it. It keeps nothing of its own - each opening starts from the mesh's defaults,
 * and only a bake added to the library stays.
 */

import { atlasLayout } from "../domain/volumeAtlas";
import { bakeGridSize, VOLUME_RESOLUTION_RANGE, type VolumeBakeMode } from "../domain/volumeBake";
import { t } from "../i18n";
import type { MeshAsset } from "../model/editorState";
import type { Store } from "../model/store";
import { VolumeBakeSession } from "../model/volumeBakeSession";
import { VolumeBakePreview } from "../render/volumeBakePreview";
import { NumberControl } from "./components/numberControl";
import { createSegmentedControl } from "./components/segmentedControl";
import { attachTooltip } from "./components/tooltip";
import { createElement } from "./dom";
import { actionIcons, assetIcons, glyphIcons } from "./icons";
import { outlineButton, setOutlineLabel } from "./outlineButton";
import { axisRow, axisTriplet, readTriplet, setTriplet } from "./panels/axisFields";
import { numberRow, setRowsHidden, SETTINGS_ROW } from "./panels/settingsRows";
import { field } from "./primitives/field";

export interface VolumeBaker {
  readonly element: HTMLElement;
  /** Starts baking `mesh` afresh. */
  open(mesh: MeshAsset): void;
  /** Ends the bake, dropping what was not added. */
  close(): void;
}

/** A button of the settings block. */
function button(glyph: string, label: string, tip: string): HTMLButtonElement {
  return outlineButton(glyph, label, tip, "content-export__button");
}

/** `row` with the tooltip of what it sets. */
function withTip(row: HTMLElement, title: string, tip: string): HTMLElement {
  attachTooltip(row, title, tip);
  return row;
}

/** `onBack` returns to the sheet's blocks: after a volume is added, or when the user leaves. */
export function createVolumeBaker(store: Store, onBack: () => void): VolumeBaker {
  const session = new VolumeBakeSession(store);

  const commitBox = (): void =>
    session.setSettings({ boxMin: readTriplet(boxMin), boxMax: readTriplet(boxMax) });
  const boxMin = axisTriplet({ step: 0.01, precision: 3, compact: true }, commitBox, commitBox);
  const boxMax = axisTriplet({ step: 0.01, precision: 3, compact: true }, commitBox, commitBox);
  const resolution = numberRow(
    t("baker.resolution"),
    64,
    { ...VOLUME_RESOLUTION_RANGE, step: 1, precision: 0 },
    (value) => session.setSettings({ resolution: value }),
  );
  const band = numberRow(t("baker.band"), 0.1, { min: 0.0001, step: 0.01, precision: 3 }, (value) =>
    session.setSettings({ band: value }),
  );
  const mode = createSegmentedControl<VolumeBakeMode>(
    [
      { key: "solid", label: t("baker.solid"), description: t("baker.solidTip") },
      { key: "shell", label: t("baker.shell"), description: t("baker.shellTip") },
    ],
    "solid",
    (key) => session.setSettings({ mode: key }),
  );
  const thickness = numberRow(
    t("baker.thickness"),
    0,
    { min: 0, step: 0.01, precision: 3 },
    (value) => session.setSettings({ thickness: value }),
  );
  const level = new NumberControl({
    value: 0,
    step: 0.01,
    precision: 3,
    onChange: (value): void => session.setLevel(value),
    live: (value): void => session.setLevel(value),
  });

  const source = createElement("div", { className: "volume-baker__note" });
  const grid = createElement("div", { className: "volume-baker__note" });
  const openMesh = createElement("div", {
    className: "volume-baker__note volume-baker__note--warning",
    textContent: t("baker.openMesh"),
  });
  const fit = button(assetIcons.mesh, t("baker.fit"), t("baker.fitTip"));
  fit.addEventListener("click", () => session.fitBox());
  // In the corner the sheet's close button takes on its other screen: the baker returns to the
  // library, for another mesh to bake.
  const back = outlineButton(
    glyphIcons.chevronLeft,
    t("baker.back"),
    t("baker.backTip"),
    "volume-baker__back",
  );
  back.addEventListener("click", () => leave());
  const reset = button(actionIcons.undo, t("baker.reset"), t("baker.resetTip"));
  reset.addEventListener("click", () => session.reset());
  const bake = button(assetIcons.bakeVolume, t("baker.bake"), t("baker.bakeTip"));
  bake.addEventListener("click", () => {
    if (session.get()?.progress === undefined) {
      void session.runBake();
    } else {
      session.stopBake();
    }
  });
  const add = button(assetIcons.download, t("baker.add"), t("baker.addTip"));
  add.addEventListener("click", () => {
    void session.addToLibrary().then(() => {
      if (session.get() === undefined) {
        onBack();
      }
    });
  });

  // The level is the view's alone, so it sits over the view, as the main preview's cards do.
  const levelCard = field(t("baker.level"), level.element, {
    rowClassName: "viewport-card volume-baker__overlay",
    labelClassName: "volume-baker__overlay-label",
  });
  attachTooltip(levelCard, t("baker.level"), t("baker.levelTip"));
  const view = createElement("div", { className: "volume-baker__view" }, [levelCard]);
  new VolumeBakePreview(view, session);

  const settingsBlock = createElement(
    "div",
    { className: "content-export volume-baker__settings" },
    [
      createElement("div", {
        className: "content-sheet__title content-export__title",
        textContent: t("baker.title"),
      }),
      createElement("div", { className: "content-export__form" }, [
        source,
        createElement("div", { className: "preview-settings" }, [
          withTip(axisRow(t("baker.boxMin"), boxMin), t("baker.boxMin"), t("baker.boxTip")),
          withTip(axisRow(t("baker.boxMax"), boxMax), t("baker.boxMax"), t("baker.boxTip")),
          withTip(resolution.element, t("baker.resolution"), t("baker.resolutionTip")),
          withTip(band.element, t("baker.band"), t("baker.bandTip")),
          withTip(
            field(t("baker.mode"), mode.element, SETTINGS_ROW),
            t("baker.mode"),
            t("baker.modeTip"),
          ),
          withTip(thickness.element, t("baker.thickness"), t("baker.thicknessTip")),
        ]),
        fit,
        grid,
        openMesh,
        createElement("div", { className: "content-export__row" }, [reset, bake]),
        add,
      ]),
    ],
  );
  const element = createElement("div", { className: "volume-baker" }, [view, settingsBlock, back]);

  session.subscribe(() => {
    const state = session.get();
    if (state === undefined) {
      return;
    }
    const { settings } = state;
    source.textContent = t("baker.source", { mesh: state.mesh.label });
    setTriplet(boxMin, settings.boxMin);
    setTriplet(boxMax, settings.boxMax);
    resolution.setValue(settings.resolution);
    band.setValue(settings.band);
    mode.setValue(settings.mode);
    thickness.setValue(settings.thickness);
    setRowsHidden([thickness.element], settings.mode !== "shell");
    level.setValue(state.level);
    const size = bakeGridSize(settings);
    const atlas = atlasLayout(size);
    grid.textContent = t("baker.grid", {
      size: size.join("x"),
      kilobytes: String(Math.ceil((size[0] * size[1] * size[2]) / 1024)),
      atlas: `${String(atlas.width)}x${String(atlas.height)}`,
    });
    openMesh.hidden = state.closed;
    setOutlineLabel(
      bake,
      state.progress === undefined
        ? t("baker.bake")
        : t("baker.cancel", { percent: String(Math.floor(state.progress * 100)) }),
    );
    back.disabled = state.progress !== undefined;
    add.disabled = state.baked === undefined;
  });

  function leave(): void {
    session.close();
    onBack();
  }

  return {
    element,
    open: (mesh): void => session.start(mesh),
    close: (): void => session.close(),
  };
}
