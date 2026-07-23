/**
 * The Help block of the Content sheet: a static quick-reference panel - a getting-started note, a
 * few misc mechanics worth knowing, and the editor's keyboard shortcuts. Pure content, no
 * store/signals; it never changes at runtime, so unlike the other two blocks it needs no `sync()`.
 */

import { t, type TKey } from "../i18n";
import { createElement } from "./dom";

interface ShortcutEntry {
  /** The physical key combo, e.g. "Ctrl+Z" - a literal label, not translated. */
  readonly keys: string;
  readonly labelKey: TKey;
}

const MISC: readonly TKey[] = [
  "content.helpMiscCountdown",
  "content.helpMiscTooltips",
  "content.helpMiscCost",
];

// Physical key combos (locale-agnostic) paired with their action, pulled from the actual
// keymaps (hotkeys.ts, timelinePanel.ts, graphCanvas.ts) rather than invented.
const SHORTCUTS: readonly ShortcutEntry[] = [
  { keys: "Ctrl+Z", labelKey: "content.shortcutUndo" },
  { keys: "Ctrl+Shift+Z", labelKey: "content.shortcutRedo" },
  { keys: "Space", labelKey: "content.shortcutPlayPause" },
  { keys: "Ctrl+C / Ctrl+V", labelKey: "content.shortcutCopyPaste" },
  { keys: "Delete / Backspace / X", labelKey: "content.shortcutDelete" },
  { keys: "F", labelKey: "content.shortcutFrame" },
  { keys: "A", labelKey: "content.shortcutAddNode" },
  { keys: "C", labelKey: "content.shortcutComment" },
  { keys: "I", labelKey: "content.shortcutKeyframe" },
];

/** The two lines that each name a pair of graph/tier concepts - built with the real tab labels
 *  (graph.modeBehavior etc.) interpolated in, so the terms match what the user sees on the tabs. */
function gettingStartedLines(): readonly string[] {
  return [
    t("content.helpIntroGraphs", {
      behavior: t("graph.modeBehavior"),
      render: t("graph.modeRender"),
    }),
    t("content.helpIntroTiers", {
      baseline: t("preview.renderBackendBaseline"),
      standard: t("preview.renderBackendStandard"),
    }),
    t("content.helpIntroUndo"),
  ];
}

/** Builds the Help block. Static: called once, never resynced. */
export function helpBlock(): { element: HTMLElement } {
  const title = createElement("div", {
    className: "content-sheet__title",
    textContent: t("content.help"),
  });

  const intro = createElement(
    "div",
    { className: "content-help__intro" },
    gettingStartedLines().map((text) => line(text)),
  );

  const misc = createElement(
    "div",
    { className: "content-help__misc" },
    MISC.map((key) => line(t(key))),
  );

  const shortcuts = createElement(
    "div",
    { className: "content-help__shortcuts" },
    SHORTCUTS.map((entry) =>
      createElement("div", { className: "content-help__shortcut-row" }, [
        createElement("span", { className: "content-help__shortcut-key", textContent: entry.keys }),
        createElement("span", {
          className: "content-help__shortcut-label",
          textContent: t(entry.labelKey),
        }),
      ]),
    ),
  );

  const body = createElement("div", { className: "content-help__body" }, [
    sectionTitle(t("content.helpGettingStarted")),
    intro,
    sectionTitle(t("content.helpMisc")),
    misc,
    sectionTitle(t("content.helpShortcuts")),
    shortcuts,
  ]);

  return { element: createElement("div", { className: "content-help" }, [title, body]) };
}

/** A subgroup-tier caption, matching the asset-type section headings beside it. */
function sectionTitle(label: string): HTMLElement {
  return createElement("div", { className: "content-group__title", textContent: label });
}

/** One plain body paragraph. */
function line(text: string): HTMLElement {
  return createElement("p", { className: "content-help__line", textContent: text });
}
