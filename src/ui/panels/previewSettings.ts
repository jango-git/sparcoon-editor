/**
 * Lighting / Scene / Gizmo view-settings groups, hosted as tabs by the viewport's transform panel
 * (see {@link createViewportTransform}). View state only - never touches the model, commands or
 * undo; the environment picker only reads the content library, like any other selector.
 */

import { t } from "../../i18n";
import { setActiveEnvironment } from "../../model/commands";
import type { SignalBus } from "../../model/signals";
import { selectEnvironmentAssets } from "../../model/selectors";
import type { Store } from "../../model/store";
import type { GizmoSettingsStore, SnapSetting } from "../../settings/gizmoSettings";
import type { PreviewSettingsStore } from "../../settings/previewSettings";
import { ColorPicker } from "../components/colorPicker";
import { Dropdown, type DropdownOption } from "../components/dropdown";
import { NumberControl } from "../components/numberControl";
import { createSegmentedControl } from "../components/segmentedControl";
import { createSwitchControl } from "../components/switchControl";
import { createToggleButton } from "../components/toggleButton";
import type { Rgba } from "../components/color";
import { createElement } from "../dom";
import { controlIcons, viewportIcons } from "../icons";
import { field } from "../primitives/field";

/** A view-settings tab: a label, its glyph and the rows of controls that fill its panel. */
export interface PreviewSettingsGroup {
  readonly label: string;
  readonly glyph: string;
  readonly rows: readonly HTMLElement[];
}

/** A settings row plus a resync hook, so a store {@link PersistedStore.reset} (preset apply /
 *  project load) can push the restored value into the control that renders it, not just the
 *  store behind it. */
interface SettingsRow<TValue> {
  readonly element: HTMLElement;
  readonly setValue: (value: TValue) => void;
}

/** The class pair every Lighting/Scene/Gizmo settings row shares. */
const PREVIEW_ROW = {
  rowClassName: "preview-settings__row",
  labelClassName: "preview-settings__label",
} as const;

export function createPreviewSettingsGroups(
  settings: PreviewSettingsStore,
  gizmo: GizmoSettingsStore,
  store: Store,
  signals: SignalBus,
): PreviewSettingsGroup[] {
  const current = settings.get();
  const gizmoCurrent = gizmo.get();

  // Value controls are built inline (not just declared) so they can be resynced via set/setValue
  // when an active environment overwrites sun* with HDRI-derived values, or a whole-store reset
  // restores factory defaults (see applyPreviewState).
  const sunEnabledControl = createSwitchControl({
    title: t("preview.enabled"),
    description: t("preview.enabledTip"),
    value: current.sun,
    onChange: (on) => settings.update({ sun: on }),
  });
  const sunToggleRow = field(t("preview.enabled"), sunEnabledControl.element, PREVIEW_ROW);
  const sunColorControl = new ColorPicker({
    value: current.sunColor,
    alpha: false,
    onChange: (value): void => settings.update({ sunColor: value }),
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
    field(t("field.color"), sunColorControl.element, PREVIEW_ROW),
    field(t("field.intensity"), sunIntensityControl.element, PREVIEW_ROW),
    field(t("preview.azimuth"), sunAzimuthControl.element, PREVIEW_ROW),
    field(t("preview.elevation"), sunElevationControl.element, PREVIEW_ROW),
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
  const hemisphereSkyRow = colorRow(t("preview.skyColor"), current.hemisphereSky, (value) =>
    settings.update({ hemisphereSky: value }),
  );
  const hemisphereGroundRow = colorRow(
    t("preview.groundColor"),
    current.hemisphereGround,
    (value) => settings.update({ hemisphereGround: value }),
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
  const presetPickerRow = presetRow(store, signals);
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
  const backgroundRow = colorRow(t("preview.background"), current.background, (value) =>
    settings.update({ background: value }),
  );
  // An active environment (ADR-0004) fully replaces the manual fallback fields (hidden, not
  // greyed), and keeps resyncing Sun's value controls since main.ts overwrites sun* once the HDRI
  // derivation finishes - Sun itself is never hidden or blocked, the user can still edit it. Every
  // other row resyncs unconditionally, so a store reset (preset apply / project load) redraws the
  // whole Lighting/Scene tab from the restored defaults, not just Sun.
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
    gridRow.setValue(latest.grid);
    playerFigureRow.setValue(latest.playerFigure);
    backgroundRow.setValue(latest.background);
  };
  applyPreviewState();
  // previewSettings changes cover Sun's own value resync (main.ts overwrites sun* there) and a
  // full reset; the active environment itself lives in the document, so its own changes need the
  // source signals too - a whole-project replace (preset/import) commits "structural", a plain
  // pick commits "view", never both (see Store.emitForKind).
  settings.subscribe(applyPreviewState);
  signals.on("sourceStructureChanged", applyPreviewState);
  signals.on("sourceViewChanged", applyPreviewState);

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
      rows: [gridRow.element, playerFigureRow.element, backgroundRow.element],
    },
    {
      // Gizmo: the modal transform tool's axis space (Local/Global) and per-mode snap increments.
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
    element: field(label, control.element, PREVIEW_ROW),
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
    element: field(t("preview.space"), control.element, PREVIEW_ROW),
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
    element: field(label, value, PREVIEW_ROW),
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
): SettingsRow<Rgba> {
  const picker = new ColorPicker({ value: initial, alpha: false, onChange });
  return {
    element: field(label, picker.element, PREVIEW_ROW),
    setValue: (value) => picker.setValue(value),
  };
}

/** A labelled scrubbable numeric row. */
function numberRow(
  label: string,
  initial: number,
  bounds: { min?: number; max?: number; step?: number; precision?: number },
  onChange: (value: number) => void,
): SettingsRow<number> {
  const control = new NumberControl({ value: initial, ...bounds, onChange });
  return {
    element: field(label, control.element, PREVIEW_ROW),
    setValue: (value) => control.setValue(value),
  };
}

/** A muted subsection caption spanning the tab's full width (grid-column set in CSS). */
function sectionTitle(label: string): HTMLElement {
  return createElement("div", {
    className: "preview-settings__section-title",
    textContent: label,
  });
}

/** Hides every row in `rows` entirely (not just greyed), or restores them. */
function setRowsHidden(rows: readonly HTMLElement[], hidden: boolean): void {
  for (const row of rows) {
    row.classList.toggle("preview-settings__row--hidden", hidden);
  }
}

/**
 * The active-environment picker (ADR-0004), labelled "Preset" inside the Environment section: a
 * dropdown of the content library's HDRI assets plus "None". `options` is mutated in place (not
 * replaced) so {@link Dropdown}, which reads it fresh each time its menu opens, always sees the
 * current library without its own resync API.
 */
function presetRow(store: Store, signals: SignalBus): HTMLElement {
  const NONE_VALUE = "";
  const options: DropdownOption[] = [{ value: NONE_VALUE, label: t("preview.environmentNone") }];
  const populateOptions = (): void => {
    options.length = 1;
    for (const asset of selectEnvironmentAssets(store)) {
      options.push({ value: asset.name, label: asset.label });
    }
  };
  // Populated before construction, not after: Dropdown renders its label from `options` in its own
  // constructor, so building it against the still-empty placeholder-only array (then patching
  // `options` a moment later via `refresh`) left a restored `activeEnvironmentName` displaying as
  // "None" on reload - `setValue`'s no-op-when-unchanged guard never re-ran the label sync once
  // `options` caught up, since `current` had already been set correctly at construction time.
  populateOptions();
  const dropdown = new Dropdown({
    options,
    value: store.getSource().activeEnvironmentName ?? NONE_VALUE,
    placeholder: t("preview.environmentNone"),
    onChange: (value): void =>
      setActiveEnvironment(store, value === NONE_VALUE ? undefined : value),
  });

  const refresh = (): void => {
    populateOptions();
    const active = store.getSource().activeEnvironmentName;
    dropdown.setValue(
      active !== undefined && options.some((option) => option.value === active)
        ? active
        : NONE_VALUE,
    );
  };
  // A plain pick or asset-library edit commits "view"; a whole-project replace (preset/import)
  // commits "structural" - never both (see Store.emitForKind) - so both need a listener here.
  signals.on("sourceViewChanged", refresh);
  signals.on("sourceStructureChanged", refresh);

  return field(t("preview.preset"), dropdown.element, PREVIEW_ROW);
}
