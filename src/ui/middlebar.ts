/**
 * Middlebar chrome: undo/redo/content buttons, the transport controls, the language select, the
 * input-mode toggle and the theme control. Sends commands to the model and reflects model events;
 * holds no document state. Compile failures surface in the graph region's own error frame, not here.
 */

import { getThemeMode, onThemeChanged, setThemeMode, type ThemeMode } from "../settings/theme";
import { availableLocales, getLocale, localeBadge, LOCALE_NAMES, setLocale, t } from "../i18n";
import { createElement } from "./dom";
import { createSegmentedControl, type SegmentOption } from "./components/segmentedControl";
import { Dropdown } from "./components/dropdown";
import { attachTooltip } from "./components/tooltip";
import type { EditorContext } from "./editorContext";
import { actionIcons, graphModeIcons, icon, themeIcons } from "./icons";
import { InputMode, type InputModeState } from "./inputMode";
import { createTransportControls } from "./transportControls";

export interface MiddlebarActions {
  readonly onOpenAssets: () => void;
}

function iconButton(
  svg: string,
  title: string,
  description: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = createElement("button", { className: "middlebar__button" });
  button.append(icon(svg));
  attachTooltip(button, title, description);
  button.addEventListener("click", onClick);
  return button;
}

/** A three-position segmented control (light / auto / dark) - one click picks that mode outright. */
function createThemeToggle(): HTMLElement {
  const options: readonly SegmentOption<ThemeMode>[] = [
    {
      key: "light",
      label: t("theme.light"),
      glyph: themeIcons.light,
      description: t("theme.lightTip"),
    },
    {
      key: "auto",
      label: t("theme.auto"),
      glyph: themeIcons.auto,
      description: t("theme.autoTip"),
    },
    {
      key: "dark",
      label: t("theme.dark"),
      glyph: themeIcons.dark,
      description: t("theme.darkTip"),
    },
  ];
  const control = createSegmentedControl(options, getThemeMode(), setThemeMode);
  control.element.classList.add("middlebar__theme-switch");
  onThemeChanged(() => control.setValue(getThemeMode()));
  return control.element;
}

/**
 * The global Mouse/Touchpad navigation toggle: two adjacent icon buttons, the active mode carrying
 * the accent. It sets the shared {@link InputModeState} the graph and viewport both read - moved
 * here off the graph so the choice applies everywhere.
 */
function createInputModeToggle(inputMode: InputModeState): HTMLElement {
  const buttons = new Map<InputMode, HTMLButtonElement>();

  const build = (mode: InputMode, svg: string): HTMLButtonElement => {
    const button = createElement("button", { className: "middlebar__button" });
    button.type = "button";
    button.append(icon(svg));
    const isMouse = mode === InputMode.Mouse;
    attachTooltip(
      button,
      isMouse ? t("inputMode.mouse") : t("inputMode.touchpad"),
      isMouse ? t("inputMode.mouseTip") : t("inputMode.touchpadTip"),
    );
    button.addEventListener("click", () => inputMode.setMode(mode));
    buttons.set(mode, button);
    return button;
  };

  const group = createElement("div", { className: "middlebar__theme" }, [
    build(InputMode.Mouse, graphModeIcons.mouse),
    build(InputMode.Touchpad, graphModeIcons.touchpad),
  ]);

  const refresh = (): void => {
    for (const [mode, button] of buttons) {
      const on = mode === inputMode.mode;
      button.classList.toggle("middlebar__button--active", on);
      button.setAttribute("aria-pressed", String(on));
    }
  };
  refresh();
  inputMode.onChange(refresh);

  return group;
}

/**
 * The interface-language switch, ported from the tesselot editor: a compact trigger showing the
 * active locale badge (e.g. "EN"); clicking opens a grid of the available languages, each labelled
 * by name with the badge as a hint. Selecting one persists it and reloads (see setLocale).
 */
function createLanguageSelect(): HTMLElement {
  const dropdown = new Dropdown({
    options: availableLocales().map((code) => ({
      value: code,
      label: LOCALE_NAMES[code] ?? code,
      hint: localeBadge(code),
    })),
    value: getLocale(),
    columns: 3,
    ariaLabel: t("lang.label"),
    className: "middlebar__lang",
    triggerLabel: (_option, value): string => localeBadge(value),
    onChange: (value): void => setLocale(value),
  });
  attachTooltip(dropdown.element, t("lang.label"), t("lang.tip"));
  return dropdown.element;
}

export function createMiddlebar(context: EditorContext, actions: MiddlebarActions): HTMLElement {
  const { store, signals, transport, inputMode } = context;
  const undoButton = iconButton(actionIcons.undo, t("middlebar.undo"), t("middlebar.undoTip"), () =>
    store.undo(),
  );
  const redoButton = iconButton(actionIcons.redo, t("middlebar.redo"), t("middlebar.redoTip"), () =>
    store.redo(),
  );
  const contentButton = iconButton(
    actionIcons.content,
    t("middlebar.content"),
    t("middlebar.contentTip"),
    () => actions.onOpenAssets(),
  );

  const separator = createElement("div", { className: "middlebar__separator" });
  const themeToggle = createThemeToggle();
  const inputModeToggle = createInputModeToggle(inputMode);

  const refreshHistoryButtons = (): void => {
    undoButton.disabled = !store.canUndo;
    redoButton.disabled = !store.canRedo;
  };
  refreshHistoryButtons();
  signals.on("historyChanged", refreshHistoryButtons);

  // Left cluster: history + content. Centre: the transport (framed by flexible spacers). Right:
  // language, input mode, theme.
  return createElement("header", { className: "middlebar" }, [
    undoButton,
    redoButton,
    contentButton,
    separator,
    createElement("div", { className: "middlebar__spacer" }),
    createTransportControls(store, signals, transport),
    createElement("div", { className: "middlebar__spacer" }),
    createLanguageSelect(),
    createElement("div", { className: "middlebar__separator" }),
    inputModeToggle,
    createElement("div", { className: "middlebar__separator" }),
    themeToggle,
  ]);
}
