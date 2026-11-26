/**
 * Graph region: the dominant workspace canvas, hosting the {@link GraphCanvas} node editor. When
 * the active graph fails to compile, the region turns red and a bottom error strip surfaces the
 * engine's messages - the only place compile errors show. When the outliner's VFX group (rather
 * than an emitter/mesh) is selected, the canvas gives way to a "no graph" hint instead.
 */

import { computeGraphStats } from "../../domain/graphStats";
import { t, type TKey } from "../../i18n";
import { setEmitterStrip } from "../../model/commands";
import type { LiveApplyStatus } from "../../model/editorState";
import {
  authoredGraphs,
  GRAPH_SLOTS,
  STRIP_NAMES,
  type StripName,
  stripSlot,
} from "../../model/graphSlots";
import {
  type ActiveGraphOwner,
  selectActiveGraphOwner,
  selectGraphStatus,
} from "../../model/selectors";
import type { Store } from "../../model/store";
import { attachCountdownConfirm } from "../components/countdownConfirm";
import { attachTooltip, clearTooltip } from "../components/tooltip";
import { createElement } from "../dom";
import type { EditorContext } from "../editorContext";
import { GraphCanvas } from "../graph/graphCanvas";
import { GraphMode, graphModeLabel, type GraphViewState } from "../graphViewState";
import { actionIcons, graphModeIcons, icon } from "../icons";
import { createGraphStats } from "./graphStats";

/** Presses to confirm removing an emitter's trail or ribbon (see {@link attachCountdownConfirm}). */
const REMOVE_STRIP_CLICKS = 3;
/** Presses to confirm auto-arranging the graph: it rewires routes and moves comments (undoable). */
const ARRANGE_CLICKS = 2;

/** What can be done to a graph laid out from its cards as drawn, once it is shown. */
export type ShownGraph = Pick<GraphCanvas, "arrange" | "gatherIntoComment">;

export interface GraphPanel {
  readonly element: HTMLElement;
  /** Shows graph `mode` of the active owner. */
  readonly show: (mode: GraphMode) => ShownGraph;
}

export function createGraphPanel(context: EditorContext, graphView: GraphViewState): GraphPanel {
  const { store, selection } = context;
  const graph = createElement("div", { className: "graph" });
  const canvas = new GraphCanvas(graph, context, graphView);
  graph.append(createGraphSwitch(graphView, store), createArrangeButton(canvas));

  // The VFX group (the outliner's root row) owns no graph of its own - unlike picking an
  // emitter/mesh, selecting it commits nothing to the model (no id to make active), so nothing
  // else here would otherwise notice; without this the canvas would just keep showing whatever
  // emitter/mesh graph was active before. `.graph--no-owner` (styles/graph.css) hides the canvas,
  // switch, stats and error strip in favor of this hint - purely presentational, so the canvas
  // underneath is left untouched and reappears exactly as it was once a real owner is picked again.
  const hint = createElement("div", {
    className: "graph__hint",
    textContent: t("graph.noGroupGraph"),
  });
  hint.hidden = true;
  graph.append(hint);
  const updateOwnerVisibility = (): void => {
    const noOwner = selection.get().kind === "vfx";
    graph.classList.toggle("graph--no-owner", noOwner);
    hint.hidden = !noOwner;
  };
  updateOwnerVisibility();
  selection.subscribe(updateOwnerVisibility);

  const stats = createGraphStats();
  graph.append(stats.element);
  // Nodes and cost summed over every graph the active owner authors. Changes only on a structural
  // edit.
  const updateStats = (): void => {
    const totals = authoredGraphs(selectActiveGraphOwner(store)).map(({ name, graph: authored }) =>
      computeGraphStats(GRAPH_SLOTS[name].kind, authored),
    );
    stats.report(
      totals.reduce((sum, total) => sum + total.nodeCount, 0),
      totals.reduce((sum, total) => sum + total.cost, 0),
    );
  };
  updateStats();
  store.events.sourceStructureChanged.on(updateStats);

  const errors = createElement("div", { className: "graph__errors" });
  errors.hidden = true;
  graph.append(errors);

  const updateErrors = (): void => {
    const status = selectGraphStatus(store, graphView.mode);
    renderErrors(graph, errors, status, (nodeId) => canvas.focusNode(nodeId));
  };
  updateErrors();
  store.events.derivedChanged.on(updateErrors);
  graphView.onChange(updateErrors);

  return {
    element: graph,
    show: (mode): ShownGraph => {
      graphView.setMode(mode);
      return canvas;
    },
  };
}

/** The floating Arrange button in the graph's top-right corner, guarded by a countdown. */
function createArrangeButton(canvas: GraphCanvas): HTMLElement {
  const content = `${actionIcons.arrange}<span>${t("graph.arrange")}</span>`;
  const button = createElement("button", {
    className: "graph-switch__button graph-arrange",
    type: "button",
  });
  button.innerHTML = content;
  attachTooltip(button, t("graph.arrange"), t("graph.arrangeTip"));
  attachCountdownConfirm(button, content, ARRANGE_CLICKS, () => canvas.arrange());
  return button;
}

/** What the graph switch shows for one strip: its button, doubling as "add", and its remove. */
const STRIP_SWITCH: Readonly<
  Record<
    StripName,
    {
      readonly mode: GraphMode;
      readonly icon: string;
      readonly add: TKey;
      readonly addTip: TKey;
      readonly remove: TKey;
      readonly removeTip: TKey;
    }
  >
> = {
  trail: {
    mode: GraphMode.Trail,
    icon: graphModeIcons.trail,
    add: "graph.addTrail",
    addTip: "graph.addTrailTip",
    remove: "graph.removeTrail",
    removeTip: "graph.removeTrailTip",
  },
  ribbon: {
    mode: GraphMode.Ribbon,
    icon: graphModeIcons.ribbon,
    add: "graph.addRibbon",
    addTip: "graph.addRibbonTip",
    remove: "graph.removeRibbon",
    removeTip: "graph.removeRibbonTip",
  },
};

/**
 * One strip's part of the graph switch: a button showing its graph - doubling as an "add" action
 * while the emitter has none - and a remove button beside it while it has one. `refresh` follows
 * the active owner.
 */
function createStripSwitch(
  strip: StripName,
  graphView: GraphViewState,
  store: Store,
): {
  readonly button: HTMLButtonElement;
  readonly remove: HTMLButtonElement;
  readonly refresh: (owner: ActiveGraphOwner) => void;
} {
  const labels = STRIP_SWITCH[strip];
  const slot = stripSlot(strip);
  const button = createElement("button", {
    className: "graph-switch__button",
    type: "button",
  });
  const label = createElement("span");
  button.append(icon(labels.icon), label);
  button.addEventListener("click", () => {
    const owner = selectActiveGraphOwner(store);
    if (owner.kind === "emitter" && owner[slot] === undefined) {
      setEmitterStrip(store, owner.id, strip, true);
    }
    graphView.setMode(labels.mode);
  });

  const remove = createElement("button", {
    className: "graph-switch__remove confirm-danger",
    type: "button",
  });
  remove.innerHTML = actionIcons.trash;
  attachTooltip(remove, t(labels.remove), t(labels.removeTip));
  attachCountdownConfirm(remove, actionIcons.trash, REMOVE_STRIP_CLICKS, () => {
    const owner = selectActiveGraphOwner(store);
    if (owner.kind === "emitter") {
      setEmitterStrip(store, owner.id, strip, false);
    }
  });

  let isSwitch: boolean | undefined;
  const refresh = (owner: ActiveGraphOwner): void => {
    const has = owner[slot] !== undefined;
    label.textContent = has ? graphModeLabel(labels.mode) : t(labels.add);
    button.classList.toggle("graph-switch__button--add", !has);
    // Doubling as "add", the button says what a click will do; as the plain switch it needs no
    // more than its label, like Behavior and Render. Only on a flip: clearing hides whichever
    // tooltip is showing.
    if (has !== isSwitch) {
      isSwitch = has;
      if (has) {
        clearTooltip(button);
      } else {
        attachTooltip(button, t(labels.add), t(labels.addTip));
      }
    }
    remove.hidden = !has;
  };
  return { button, remove, refresh };
}

/**
 * The floating Behavior/Render/Trail/Ribbon switch in the graph's top-left corner; the active graph
 * is highlighted. An emitter without a trail or ribbon shows its button as an "add" action, and an
 * emitter with one shows a remove button beside it.
 */
function createGraphSwitch(graphView: GraphViewState, store: Store): HTMLElement {
  const buttons = new Map<GraphMode, HTMLButtonElement>();

  const build = (mode: GraphMode, svg: string): HTMLButtonElement => {
    const button = createElement("button", { className: "graph-switch__button" });
    button.append(icon(svg), createElement("span", { textContent: graphModeLabel(mode) }));
    button.addEventListener("click", () => graphView.setMode(mode));
    buttons.set(mode, button);
    return button;
  };

  const strips = STRIP_NAMES.map((strip) => {
    const parts = createStripSwitch(strip, graphView, store);
    buttons.set(STRIP_SWITCH[strip].mode, parts.button);
    return parts;
  });

  const group = createElement("div", { className: "graph-switch graph-switch--floating" }, [
    build(GraphMode.Behavior, graphModeIcons.behavior),
    build(GraphMode.Render, graphModeIcons.render),
    ...strips.flatMap(({ button, remove }) => [button, remove]),
  ]);

  const refresh = (): void => {
    // A VFX mesh has no authorable graph choice (render only, no behavior), so hide the whole
    // switch for it; the canvas already coerces the mode to Render.
    const owner = selectActiveGraphOwner(store);
    group.hidden = owner.kind === "vfxMesh";
    for (const strip of strips) {
      strip.refresh(owner);
    }
    for (const [mode, button] of buttons) {
      button.classList.toggle("graph-switch__button--active", mode === graphView.mode);
    }
  };
  refresh();
  graphView.onChange(refresh);
  // The active owner changes via a structural commit (selecting an emitter/mesh), so re-evaluate
  // whether Behavior should show whenever the source structure changes.
  store.events.sourceStructureChanged.on(refresh);

  return group;
}

/**
 * Rebuilds the error frame from `status`. A message with `nodeId` is a button that jumps to the
 * node, other messages are plain text. Warnings use the warning color without the red outline.
 */
function renderErrors(
  graph: HTMLElement,
  errors: HTMLElement,
  status: LiveApplyStatus | undefined,
  onFocusNode: (nodeId: string) => void,
): void {
  const invalid = status?.status === "invalid" && status.messages.length > 0;
  const warnings = invalid ? [] : (status?.warnings ?? []);
  graph.classList.toggle("graph--invalid", invalid);
  errors.classList.toggle("graph__errors--warning", warnings.length > 0);
  errors.hidden = !invalid && warnings.length === 0;
  if (errors.hidden) {
    errors.replaceChildren();
    return;
  }
  if (!invalid) {
    const title =
      warnings.length === 1
        ? t("graph.compileWarning")
        : t("graph.compileWarnings", { count: warnings.length });
    errors.replaceChildren(
      createElement("div", { className: "graph__errors-title", textContent: title }),
      ...warnings.map((warning) =>
        createElement("div", { className: "graph__error", textContent: warning }),
      ),
    );
    return;
  }
  const label =
    status.messages.length === 1
      ? t("graph.compileError")
      : t("graph.compileErrors", { count: status.messages.length });
  errors.replaceChildren(
    createElement("div", { className: "graph__errors-title", textContent: label }),
    ...status.messages.map((message, index) =>
      errorRow(message, status.errors?.[index]?.nodeId, onFocusNode),
    ),
  );
}

/** One error row: a plain line, or (when the compiler attributed it to a live node) a button that
 *  jumps the canvas there - see {@link renderErrors}. */
function errorRow(
  message: string,
  nodeId: string | undefined,
  onFocusNode: (nodeId: string) => void,
): HTMLElement {
  if (nodeId === undefined) {
    return createElement("div", { className: "graph__error", textContent: message });
  }
  const row = createElement("button", {
    className: "graph__error graph__error--clickable",
    textContent: message,
    type: "button",
  });
  attachTooltip(row, t("graph.focusErrorNode"), t("graph.focusErrorNodeTip"));
  row.addEventListener("click", () => onFocusNode(nodeId));
  return row;
}
