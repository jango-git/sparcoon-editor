/**
 * Graph region: the dominant workspace canvas, hosting the {@link GraphCanvas} node editor. When
 * the active graph fails to compile, the region turns red and a bottom error strip surfaces the
 * engine's messages - the only place compile errors show. When the outliner's VFX group (rather
 * than an emitter/mesh) is selected, the canvas gives way to a "no graph" hint instead.
 */

import { computeGraphStats } from "../../domain/graphStats";
import { t } from "../../i18n";
import { setEmitterTrail } from "../../model/commands";
import type { LiveApplyStatus } from "../../model/editorState";
import { authoredGraphs, GRAPH_SLOTS } from "../../model/graphSlots";
import { selectActiveGraphOwner, selectGraphStatus } from "../../model/selectors";
import type { SignalBus } from "../../model/signals";
import type { Store } from "../../model/store";
import { attachCountdownConfirm } from "../components/countdownConfirm";
import { attachTooltip, clearTooltip } from "../components/tooltip";
import { createElement } from "../dom";
import type { EditorContext } from "../editorContext";
import { GraphCanvas } from "../graph/graphCanvas";
import { GraphMode, graphModeLabel, type GraphViewState } from "../graphViewState";
import { actionIcons, graphModeIcons, icon } from "../icons";
import { createGraphStats } from "./graphStats";

/** Presses to confirm removing an emitter's trail (see {@link attachCountdownConfirm}). */
const REMOVE_TRAIL_CLICKS = 3;
/** Presses to confirm auto-arranging the graph: it rewires routes and drops comments (undoable). */
const ARRANGE_CLICKS = 2;

export interface GraphPanel {
  readonly element: HTMLElement;
  /** Shows graph `mode` of the active owner and auto-arranges it - the Arrange button's action. */
  readonly arrange: (mode: GraphMode) => void;
}

export function createGraphPanel(context: EditorContext, graphView: GraphViewState): GraphPanel {
  const { store, signals, selection } = context;
  const graph = createElement("div", { className: "graph" });
  const canvas = new GraphCanvas(graph, context, graphView);
  graph.append(createGraphSwitch(graphView, store, signals), createArrangeButton(canvas));

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
  // Nodes/Cost: every graph the active owner authors, summed - an emitter's render + behavior
  // pair (and its trail), or a VFX mesh's lone render graph. The Behavior/Render switch no longer changes this
  // total (each graph's own number now lives on its sink's header instead; see graphCanvas.ts's
  // `sinkCosts`). Only moves on a structural edit (a different active owner counts as one).
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
  signals.on("sourceStructureChanged", updateStats);

  const errors = createElement("div", { className: "graph__errors" });
  errors.hidden = true;
  graph.append(errors);

  const updateErrors = (): void => {
    const status = selectGraphStatus(store, graphView.mode);
    renderErrors(graph, errors, status, (nodeId) => canvas.focusNode(nodeId));
  };
  updateErrors();
  signals.on("derivedChanged", updateErrors);
  graphView.onChange(updateErrors);

  return {
    element: graph,
    arrange: (mode): void => {
      graphView.setMode(mode);
      canvas.arrange();
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

/**
 * The floating Behavior/Render/Trail switch in the graph's top-left corner; the active graph is
 * highlighted. An emitter without a trail shows the Trail button as an "add trail" action, and an
 * emitter with one shows a remove button beside it.
 */
function createGraphSwitch(
  graphView: GraphViewState,
  store: Store,
  signals: SignalBus,
): HTMLElement {
  const buttons = new Map<GraphMode, HTMLButtonElement>();

  const build = (mode: GraphMode, svg: string): HTMLButtonElement => {
    const button = createElement("button", { className: "graph-switch__button" });
    button.append(icon(svg), createElement("span", { textContent: graphModeLabel(mode) }));
    button.addEventListener("click", () => graphView.setMode(mode));
    buttons.set(mode, button);
    return button;
  };

  const trailButton = createElement("button", {
    className: "graph-switch__button",
    type: "button",
  });
  const trailLabel = createElement("span");
  trailButton.append(icon(graphModeIcons.trail), trailLabel);
  trailButton.addEventListener("click", () => {
    const owner = selectActiveGraphOwner(store);
    if (owner.kind === "emitter" && owner.trailGraph === undefined) {
      setEmitterTrail(store, owner.id, true);
    }
    graphView.setMode(GraphMode.Trail);
  });
  buttons.set(GraphMode.Trail, trailButton);

  // A trash button guarded like every other delete (countdownConfirm.ts): a whole graph goes with it.
  const removeTrail = createElement("button", {
    className: "graph-switch__remove confirm-danger",
    type: "button",
  });
  removeTrail.innerHTML = actionIcons.trash;
  attachTooltip(removeTrail, t("graph.removeTrail"), t("graph.removeTrailTip"));
  attachCountdownConfirm(removeTrail, actionIcons.trash, REMOVE_TRAIL_CLICKS, () => {
    const owner = selectActiveGraphOwner(store);
    if (owner.kind === "emitter") {
      setEmitterTrail(store, owner.id, false);
    }
  });

  const group = createElement("div", { className: "graph-switch graph-switch--floating" }, [
    build(GraphMode.Behavior, graphModeIcons.behavior),
    build(GraphMode.Render, graphModeIcons.render),
    trailButton,
    removeTrail,
  ]);

  // Whether the Trail button currently shows as the plain switch (`undefined` before the first refresh).
  let trailButtonIsSwitch: boolean | undefined;
  const refresh = (): void => {
    // A VFX mesh has no authorable graph choice (render only, no behavior), so hide the whole
    // switch for it; the canvas already coerces the mode to Render.
    const owner = selectActiveGraphOwner(store);
    group.hidden = owner.kind === "vfxMesh";
    const hasTrail = owner.trailGraph !== undefined;
    trailLabel.textContent = hasTrail ? graphModeLabel(GraphMode.Trail) : t("graph.addTrail");
    trailButton.classList.toggle("graph-switch__button--add", !hasTrail);
    // Doubling as "add trail", the button says what a click will do; as the plain Trail switch it
    // needs no more than its label, like Behavior and Render. Only on a flip: clearing hides
    // whichever tooltip is showing.
    if (hasTrail !== trailButtonIsSwitch) {
      trailButtonIsSwitch = hasTrail;
      if (hasTrail) {
        clearTooltip(trailButton);
      } else {
        attachTooltip(trailButton, t("graph.addTrail"), t("graph.addTrailTip"));
      }
    }
    removeTrail.hidden = !hasTrail;
    for (const [mode, button] of buttons) {
      button.classList.toggle("graph-switch__button--active", mode === graphView.mode);
    }
  };
  refresh();
  graphView.onChange(refresh);
  // The active owner changes via a structural commit (selecting an emitter/mesh), so re-evaluate
  // whether Behavior should show whenever the source structure changes.
  signals.on("sourceStructureChanged", refresh);

  return group;
}

/**
 * Toggles the invalid state on the region and (re)builds the error frame from `status`. A message
 * traceable to one node (`status.errors[index].nodeId` - see `render/emitterView.ts`'s
 * `invalidFromErrors`) renders as a button that calls `onFocusNode`, jumping the canvas to it; a
 * message with no such node (a cross-graph conflict, a blocked-by-the-other-graph notice, a caught
 * exception - none of which carry `errors` at all) stays plain, unclickable text. A valid graph's
 * `warnings` take the same frame in the warning color instead, without the region's red outline.
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
