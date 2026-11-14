/**
 * The overdraw view's legend over the viewport: the heat ramp the view paints, labelled with each
 * stop's layer count. Shown only while an overdraw view is on.
 */

import { OVERDRAW_RAMP } from "../../render/overdrawRamp";
import { createElement } from "../dom";
import type { PreviewViewModeState } from "../previewViewMode";

export function createOverdrawLegend(viewMode: PreviewViewModeState): HTMLElement {
  const last = OVERDRAW_RAMP.length - 1;
  // Even spacing: the view blends between stops on a log2 scale, one stop per doubling.
  const bar = createElement("div", { className: "overdraw-legend__bar" });
  bar.style.background = `linear-gradient(to right, ${OVERDRAW_RAMP.map(
    (stop, index) => `${stop.color} ${((index / last) * 100).toFixed(2)}%`,
  ).join(", ")})`;
  const labels = createElement(
    "div",
    { className: "overdraw-legend__labels" },
    OVERDRAW_RAMP.map((stop, index) =>
      createElement("span", {
        textContent: index === last ? `${stop.layers}+` : String(stop.layers),
      }),
    ),
  );
  const legend = createElement("div", { className: "viewport-card overdraw-legend" }, [
    bar,
    labels,
  ]);
  const sync = (): void => {
    legend.hidden = !viewMode.overdrawOn;
  };
  sync();
  viewMode.onChange(sync);
  return legend;
}
