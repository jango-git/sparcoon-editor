/**
 * Lighting / Scene / Gizmo view-settings groups, hosted as tabs by the viewport's transform panel
 * (see {@link createViewportTransform}). View state only - never touches the model, commands or
 * undo; the environment picker only reads the content library, like any other selector.
 */

import { t } from "../../i18n";
import { setActiveEnvironment } from "../../model/commands";
import { selectEnvironmentAssets } from "../../model/selectors";
import type { Store } from "../../model/store";
import { environmentThumbnails } from "../../render/assetThumbnails";
import type { GizmoSettingsStore, SnapSetting } from "../../settings/gizmoSettings";
import type { PreviewSettingsStore } from "../../settings/previewSettings";
import { AssetPicker, type AssetPickerOption } from "../components/assetPicker";
import type { Rgba } from "../components/color";
import { ColorPicker, type PaletteAccess } from "../components/colorPicker";
import { NumberControl } from "../components/numberControl";
import { createPaletteAccess } from "../components/paletteAccess";
import { createSegmentedControl } from "../components/segmentedControl";
import { createSwitchControl } from "../components/switchControl";
import { createToggleButton } from "../components/toggleButton";
import { createElement } from "../dom";
import { assetIcons, controlIcons, viewportIcons } from "../icons";
import { field } from "../primitives/field";
import {
  numberRow,
  sectionTitle,
  setRowsHidden,
  SETTINGS_ROW,
  type SettingsRow,
} from "./settingsRows";

/** A view-settings tab: a label, its glyph and the rows of controls that fill its panel. */
export interface PreviewSettingsGroup {
  readonly label: string;
  readonly glyph: string;
  readonly rows: readonly HTMLElement[];
}

export function createPreviewSettingsGroups(
  settings: PreviewSettingsStore,
  gizmo: GizmoSettingsStore,
  store: Store,
): PreviewSettingsGroup[] {
  const current = settings.get();
  const gizmoCurrent = gizmo.get();
  const paletteAccess = createPaletteAccess(store);

  // Value controls are built inline (not just declared) so they can be resynced via set/setValue
  // when an active environment overwrites sun* with HDRI-derived values, or a whole-store reset
  // restores factory defaults (see applyPreviewState).
  const sunEnabledControl = createSwitchControl({
    title: t("preview.enabled"),
    description: t("preview.enabledTip"),
    value: current.sun,
    onChange: (on) => settings.update({ sun: on }),
  });
  const sunToggleRow = field(t("preview.enabled"), sunEnabledControl.element, SETTINGS_ROW);
  const sunColorControl = new ColorPicker({
    value: current.sunColor,
    alpha: false,
    onChange: (value): void => settings.update({ sunColor: value }),
    palette: paletteAccess,
  });
  const sunIntensityControl = new NumberControl({
    value: current.sunIntensity,
    min: 0,
    max: 10,
    step: 0.05,
    onChange: (value): void => settings.update({ sunIntensity: value }),
  });
  const sunAzimuthControl = new NumberControl({
    value: current.sunAzimuth,
    min: 0,
    max: 360,
    step: 1,
    precision: 0,
    onChange: (value): void => settings.update({ sunAzimuth: value }),
  });
  const sunElevationControl = new NumberControl({
    value: current.sunElevation,
    min: 0,
    max: 90,
    step: 1,
    precision: 0,
    onChange: (value): void => settings.update({ sunElevation: value }),
  });
  const sunValueRows = [
    field(t("field.color"), sunColorControl.element, SETTINGS_ROW),
    field(t("field.intensity"), sunIntensityControl.element, SETTINGS_ROW),
    field(t("preview.azimuth"), sunAzimuthControl.element, SETTINGS_ROW),
    field(t("preview.elevation"), sunElevationControl.element, SETTINGS_ROW),
  ];
  const sunRows = [sunToggleRow, ...sunValueRows];
  // The manual Sun+Hemisphere fallback fields - hidden outright once a preset takes over (see
  // applyPreviewState). Sun's own rows are never touched here: it keeps deriving from the
  // environment (below) without ever being blocked.
  const hemisphereToggleRow = toggleRow(
    t("preview.enabled"),
    current.hemisphere,
    (on) => settings.update({ hemisphere: on }),
    t("preview.enabledTip"),
  );
  const hemisphereSkyRow = colorRow(
    t("preview.skyColor"),
    current.hemisphereSky,
    (value) => settings.update({ hemisphereSky: value }),
    paletteAccess,
  );
  const hemisphereGroundRow = colorRow(
    t("preview.groundColor"),
    current.hemisphereGround,
    (value) => settings.update({ hemisphereGround: value }),
    paletteAccess,
  );
  const hemisphereIntensityRow = numberRow(
    t("field.intensity"),
    current.hemisphereIntensity,
    { min: 0, max: 5, step: 0.05 },
    (value) => settings.update({ hemisphereIntensity: value }),
  );
  const environmentFallbackRows = [
    hemisphereToggleRow,
    hemisphereSkyRow,
    hemisphereGroundRow,
    hemisphereIntensityRow,
  ];
  const presetPickerRow = presetRow(store);
  const groundRow = toggleRow(
    t("preview.ground"),
    current.ground,
    (on) => settings.update({ ground: on }),
    t("preview.groundTip"),
  );
  const gridRow = toggleRow(
    t("preview.grid"),
    current.grid,
    (on) => settings.update({ grid: on }),
    t("preview.gridTip"),
  );
  const playerFigureRow = toggleRow(
    t("preview.playerFigure"),
    current.playerFigure,
    (on) => settings.update({ playerFigure: on }),
    t("preview.playerFigureTip"),
  );
  const gizmosRow = toggleRow(
    t("preview.gizmos"),
    current.gizmos,
    (on) => settings.update({ gizmos: on }),
    t("preview.gizmosTip"),
  );
  const backgroundRow = colorRow(
    t("preview.background"),
    current.background,
    (value) => settings.update({ background: value }),
    paletteAccess,
  );
  // An active environment hides the manual fallback fields. Sun stays editable and keeps resyncing,
  // because main.ts overwrites sun* when the HDRI derivation finishes. Every other row resyncs
  // unconditionally, so a store reset redraws the whole tab.
  const applyPreviewState = (): void => {
    const latest = settings.get();
    const active = store.getSource().activeEnvironmentName !== undefined;
    setRowsHidden(
      environmentFallbackRows.map((row) => row.element),
      active,
    );
    if (active) {
      sunEnabledControl.set(latest.sun);
      sunColorControl.setValue(latest.sunColor);
      sunIntensityControl.setValue(latest.sunIntensity);
      sunAzimuthControl.setValue(latest.sunAzimuth);
      sunElevationControl.setValue(latest.sunElevation);
    }
    hemisphereToggleRow.setValue(latest.hemisphere);
    hemisphereSkyRow.setValue(latest.hemisphereSky);
    hemisphereGroundRow.setValue(latest.hemisphereGround);
    hemisphereIntensityRow.setValue(latest.hemisphereIntensity);
    groundRow.setValue(latest.ground);
    gridRow.setValue(latest.grid);
    playerFigureRow.setValue(latest.playerFigure);
    gizmosRow.setValue(latest.gizmos);
    backgroundRow.setValue(latest.background);
  };
  applyPreviewState();
  // previewSettings changes cover Sun's own value resync (main.ts overwrites sun* there) and a
  // full reset; the active environment itself lives in the document, so its own changes need the
  // source signals too - a whole-project replace (preset/import) commits "structural", a plain
  // pick commits "view", never both (see Store.emitForKind).
  settings.subscribe(applyPreviewState);
  store.events.sourceStructureChanged.on(applyPreviewState);
  store.events.sourceViewChanged.on(applyPreviewState);

  const spaceRowControl = spaceRow(gizmoCurrent.space, (space) => gizmo.update({ space }));
  const moveSnapRow = snapRow(t("preview.snapMove"), gizmoCurrent.move, (value) =>
    gizmo.update({ move: value }),
  );
  const rotateSnapRow = snapRow(t("preview.snapRotate"), gizmoCurrent.rotate, (value) =>
    gizmo.update({ rotate: value }),
  );
  const scaleSnapRow = snapRow(t("field.scale"), gizmoCurrent.scale, (value) =>
    gizmo.update({ scale: value }),
  );
  // Resyncs the Gizmo tab on every gizmo-store change - unlike Lighting/Scene, nothing else in the
  // editor writes to it, but a preset apply / project load still resets it to factory defaults.
  gizmo.subscribe(() => {
    const latest = gizmo.get();
    spaceRowControl.setValue(latest.space);
    moveSnapRow.setValue(latest.move);
    rotateSnapRow.setValue(latest.rotate);
    scaleSnapRow.setValue(latest.scale);
  });

  return [
    {
      label: t("preview.lighting"),
      glyph: viewportIcons.sun,
      rows: [
        sectionTitle(t("preview.sun")),
        ...sunRows,
        sectionTitle(t("preview.environment")),
        presetPickerRow,
        ...environmentFallbackRows.map((row) => row.element),
      ],
    },
    {
      label: t("preview.scene"),
      glyph: viewportIcons.scene,
      rows: [
        groundRow.element,
        gridRow.element,
        playerFigureRow.element,
        gizmosRow.element,
        backgroundRow.element,
      ],
    },
    {
      label: t("preview.gizmo"),
      glyph: viewportIcons.gizmo,
      rows: [
        spaceRowControl.element,
        moveSnapRow.element,
        rotateSnapRow.element,
        scaleSnapRow.element,
      ],
    },
  ];
}

/** A labelled boolean row: the two-position switch, parked at the start of the value column. */
function toggleRow(
  label: string,
  initial: boolean,
  onChange: (on: boolean) => void,
  description = "",
): SettingsRow<boolean> {
  const control = createSwitchControl({ title: label, description, value: initial, onChange });
  return {
    element: field(label, control.element, SETTINGS_ROW),
    setValue: (value) => control.set(value),
  };
}

/** The transform-space segmented control - Global (globe) / Local (cube) icons, not text. */
function spaceRow(
  initial: "global" | "local",
  onChange: (space: "global" | "local") => void,
): SettingsRow<"global" | "local"> {
  const control = createSegmentedControl(
    [
      {
        key: "global",
        label: t("preview.global"),
        glyph: viewportIcons.spaceGlobal,
        description: t("preview.globalTip"),
      },
      {
        key: "local",
        label: t("preview.local"),
        glyph: viewportIcons.spaceLocal,
        description: t("preview.localTip"),
      },
    ] as const,
    initial,
    onChange,
  );
  return {
    element: field(t("preview.space"), control.element, SETTINGS_ROW),
    setValue: (value) => control.setValue(value),
  };
}

/** A snap row: an on/off toggle button plus the increment the mode rounds to. */
function snapRow(
  label: string,
  initial: SnapSetting,
  onChange: (setting: SnapSetting) => void,
): SettingsRow<SnapSetting> {
  let state = initial;
  const toggle = createToggleButton({
    glyph: controlIcons.lock,
    title: t("preview.snapTitle", { label }),
    description: t("preview.snapTip"),
    value: initial.enabled,
    onChange: (on) => {
      state = { ...state, enabled: on };
      onChange(state);
    },
  });

  const step = new NumberControl({
    value: initial.step,
    min: 0.001,
    step: 0.05,
    onChange: (value): void => {
      state = { ...state, step: value };
      onChange(state);
    },
  });

  // A single value cell (lock toggle + step) so the row keeps the two-column grid.
  const value = createElement("div", { className: "preview-settings__value" }, [
    toggle.element,
    step.element,
  ]);
  return {
    element: field(label, value, SETTINGS_ROW),
    setValue(setting: SnapSetting): void {
      state = setting;
      toggle.set(setting.enabled);
      step.setValue(setting.step);
    },
  };
}

/** A labelled color-picker row (opaque, no alpha); the swatch fills its value column. */
function colorRow(
  label: string,
  initial: Rgba,
  onChange: (value: Rgba) => void,
  palette: PaletteAccess,
): SettingsRow<Rgba> {
  const picker = new ColorPicker({ value: initial, alpha: false, onChange, palette });
  return {
    element: field(label, picker.element, SETTINGS_ROW),
    setValue: (value) => picker.setValue(value),
  };
}

/**
 * The active-environment picker over the HDRI library plus "None". `options` is mutated in place
 * because AssetPicker reads it on each open.
 */
function presetRow(store: Store): HTMLElement {
  const NONE_VALUE = "";
  const options: AssetPickerOption[] = [{ name: NONE_VALUE, label: t("preview.environmentNone") }];
  // populateOptions's onReady callback closes over `refresh` before it's declared below - safe,
  // since an HDRI decode is always async (RGBELoader.load is a network fetch) and so can only ever
  // invoke that callback well after `refresh` has been assigned. It must re-run populateOptions
  // itself (like assetRows.ts's own onThumbnailReady does), not just repaint the picker: a still-
  // decoding asset has no thumbnailUrl in `options` yet, and only populateOptions re-reads the now-
  // warm cache to put one there - refreshing the picker alone would keep repainting that same gap.
  const populateOptions = (): void => {
    options.length = 1;
    const assets = selectEnvironmentAssets(store);
    const thumbnails = environmentThumbnails(assets, () => refresh());
    for (const asset of assets) {
      const thumbnailUrl = thumbnails.get(asset.name);
      options.push({
        name: asset.name,
        label: asset.label,
        ...(thumbnailUrl !== undefined ? { thumbnailUrl } : {}),
        glyph: assetIcons.hdri,
      });
    }
  };
  // Populated before construction, not after: AssetPicker renders its label from `options` in its
  // own constructor, so building it against the still-empty placeholder-only array (then patching
  // `options` a moment later via `refresh`) left a restored `activeEnvironmentName` displaying as
  // "None" on reload - `setValue`'s no-op-when-unchanged guard never re-ran the label sync once
  // `options` caught up, since `current` had already been set correctly at construction time.
  populateOptions();
  const picker = new AssetPicker({
    options,
    value: store.getSource().activeEnvironmentName ?? NONE_VALUE,
    placeholder: t("preview.environmentNone"),
    onChange: (name): void => setActiveEnvironment(store, name === NONE_VALUE ? undefined : name),
  });

  const refresh = (): void => {
    populateOptions();
    const active = store.getSource().activeEnvironmentName;
    picker.setValue(
      active !== undefined && options.some((option) => option.name === active)
        ? active
        : NONE_VALUE,
    );
    // setValue no-ops when the active name hasn't changed, so force a repaint too - a still-pending
    // HDRI thumbnail can land (onReady above) without the active name itself ever changing.
    picker.refresh();
  };
  // A plain pick or asset-library edit commits "view"; a whole-project replace (preset/import)
  // commits "structural" - never both (see Store.emitForKind) - so both need a listener here.
  store.events.sourceViewChanged.on(refresh);
  store.events.sourceStructureChanged.on(refresh);

  return field(t("preview.preset"), picker.element, SETTINGS_ROW);
}
