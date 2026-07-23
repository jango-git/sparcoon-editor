/**
 * Graph region: the dominant workspace canvas, hosting the {@link GraphCanvas} node editor. When
 * the active graph fails to compile, the region turns red and a bottom error strip surfaces the
 * engine's messages - the only place compile errors show. When the outliner's VFX group (rather
 * than an emitter/mesh) is selected, the canvas gives way to a "no graph" hint instead.
 */

import { t } from "../../i18n";
import type { EditorGraph } from "../../domain/graphModel";
import { GraphKind } from "../../domain/nodePalette";
import { computeGraphStats } from "../../domain/graphStats";
import type { LiveApplyStatus } from "../../model/editorState";
import {
  selectActiveGraphOwner,
  selectBehaviorStatus,
  selectRenderStatus,
} from "../../model/selectors";
import type { Store } from "../../model/store";
import type { SignalBus } from "../../model/signals";
import { attachTooltip } from "../components/tooltip";
import { createElement } from "../dom";
import type { EditorContext } from "../editorContext";
import { GraphCanvas } from "../graph/graphCanvas";
import { GraphMode, graphModeLabel, type GraphViewState } from "../graphViewState";
import { graphModeIcons, icon } from "../icons";
import { createGraphStats } from "./graphStats";

export function createGraphPanel(context: EditorContext, graphView: GraphViewState): HTMLElement {
  const { store, signals, selection } = context;
  const graph = createElement("div", { className: "graph" });
  const canvas = new GraphCanvas(graph, context, graphView);
  graph.append(createGraphSwitch(graphView, store, signals));

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
  // pair, or a VFX mesh's lone render graph. The Behavior/Render switch no longer changes this
  // total (each graph's own number now lives on its sink's header instead; see graphCanvas.ts's
  // `sinkCosts`). Only moves on a structural edit (a different active owner counts as one).
  const updateStats = (): void => {
    const owner = selectActiveGraphOwner(store);
    const graphs: readonly [GraphKind, EditorGraph][] =
      owner.behaviorGraph === undefined
        ? [[GraphKind.Render, owner.renderGraph]]
        : [
            [GraphKind.Render, owner.renderGraph],
            [GraphKind.Behavior, owner.behaviorGraph],
          ];
    const totals = graphs.map(([kind, editorGraph]) => computeGraphStats(kind, editorGraph));
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
    const status =
      graphView.mode === GraphMode.Render ? selectRenderStatus(store) : selectBehaviorStatus(store);
    renderErrors(graph, errors, status, (nodeId) => canvas.focusNode(nodeId));
  };
  updateErrors();
  signals.on("derivedChanged", updateErrors);
  graphView.onChange(updateErrors);

  return graph;
}

/** The floating Behavior/Render switch in the graph's top-left corner; the active graph is highlighted. */
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

  const group = createElement("div", { className: "graph-switch graph-switch--floating" }, [
    build(GraphMode.Behavior, graphModeIcons.behavior),
    build(GraphMode.Render, graphModeIcons.render),
  ]);

  const refresh = (): void => {
    // A VFX mesh has no authorable graph choice (render only, no behavior), so hide the whole
    // switch for it; the canvas already coerces the mode to Render.
    const meshOwner = selectActiveGraphOwner(store).kind === "vfxMesh";
    group.hidden = meshOwner;
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
 * exception - none of which carry `errors` at all) stays plain, unclickable text.
 */
function renderErrors(
  graph: HTMLElement,
  errors: HTMLElement,
  status: LiveApplyStatus | undefined,
  onFocusNode: (nodeId: string) => void,
): void {
  const invalid = status?.status === "invalid" && status.messages.length > 0;
  graph.classList.toggle("graph--invalid", invalid);
  errors.hidden = !invalid;
  if (!invalid) {
    errors.replaceChildren();
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
