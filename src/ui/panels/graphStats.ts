/**
 * Node count and the active owner's cost, labelled "Object cost". The caller pushes numbers via
 * {@link GraphStats.report}.
 */

import { t } from "../../i18n";
import { createElement } from "../dom";
import { field } from "../primitives/field";

export interface GraphStats {
  /** The overlay element, mounted over the graph canvas. */
  readonly element: HTMLElement;
  /** Updates the displayed reachable node count and active owner's cost. */
  report(nodeCount: number, cost: number): void;
}

export function createGraphStats(): GraphStats {
  const nodesValue = createElement("span", { className: "graph-stats__value", textContent: "-" });
  const costValue = createElement("span", { className: "graph-stats__value", textContent: "-" });
  const element = createElement("div", { className: "graph-stats" }, [
    createElement("div", { className: "graph-stats__title", textContent: t("stats.title") }),
    statRow(nodesValue, t("stats.nodes")),
    statRow(costValue, t("stats.objectCost")),
  ]);

  return {
    element,
    report(nodeCount: number, cost: number): void {
      nodesValue.textContent = nodeCount.toLocaleString("en-US");
      costValue.textContent = Math.round(cost).toLocaleString("en-US");
    },
  };
}

/** One stat: the framed value box (fixed width, shared across rows) then its label. */
function statRow(value: HTMLElement, label: string): HTMLElement {
  return field(label, value, {
    rowClassName: "graph-stats__row",
    labelClassName: "graph-stats__label",
    labelAfter: true,
  });
}
