/**
 * The preview's performance readout: a small floating panel in the bottom-left of the 3D viewport,
 * showing FPS, total particle count and whole-scene effect cost as labelled rows. Pure UI - never
 * touches the model, commands or undo. FPS/particles are pushed by the render loop every frame via
 * {@link ViewportStats.report}; effect cost is pushed separately via {@link ViewportStats.reportCost}
 * since it only changes on a structural/view edit, not every frame.
 */

import { t } from "../../i18n";
import { createElement } from "../dom";
import { field } from "../primitives/field";

export interface ViewportStats {
  /** The overlay element, mounted over the preview viewport. */
  readonly element: HTMLElement;
  /** Updates the displayed frames-per-second and total particle count (called by the render loop). */
  report(fps: number, particles: number): void;
  /** Updates the displayed whole-scene effect cost (called on a structural/view edit). */
  reportCost(cost: number): void;
}

export function createViewportStats(): ViewportStats {
  const fpsValue = createElement("span", {
    className: "viewport-stats__value",
    textContent: "-",
  });
  const particlesValue = createElement("span", {
    className: "viewport-stats__value",
    textContent: "-",
  });
  const costValue = createElement("span", {
    className: "viewport-stats__value",
    textContent: "-",
  });
  const element = createElement("div", { className: "viewport-stats" }, [
    createElement("div", { className: "viewport-stats__title", textContent: t("stats.title") }),
    statRow(fpsValue, t("field.fps")),
    statRow(particlesValue, t("stats.particles")),
    statRow(costValue, t("stats.effectCost")),
  ]);

  return {
    element,
    report(fps: number, particles: number): void {
      fpsValue.textContent = String(Math.round(fps));
      particlesValue.textContent = particles.toLocaleString("en-US");
    },
    reportCost(cost: number): void {
      costValue.textContent = Math.round(cost).toLocaleString("en-US");
    },
  };
}

/** One stat: the framed value box (fixed width, shared across rows) then its label. */
function statRow(value: HTMLElement, label: string): HTMLElement {
  return field(label, value, {
    rowClassName: "viewport-stats__row",
    labelClassName: "viewport-stats__label",
    labelAfter: true,
  });
}
