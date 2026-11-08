/**
 * The preview's performance readout: a small floating panel in the bottom-left of the 3D viewport,
 * showing FPS, total particle count, particle overflow and whole-scene effect cost as labelled
 * rows. Pure UI - never
 * touches the model, commands or undo. FPS/particles are pushed by the render loop every frame via
 * {@link ViewportStats.report}; effect cost is pushed separately via {@link ViewportStats.reportCost}
 * since it only changes on a structural/view edit, not every frame.
 */

import { t } from "../../i18n";
import type { ParticleOverflow } from "../../render/sceneEmitters";
import { attachTooltip } from "../components/tooltip";
import { createElement } from "../dom";
import { field } from "../primitives/field";

export interface ViewportStats {
  /** The overlay element, mounted over the preview viewport. */
  readonly element: HTMLElement;
  /**
   * Updates the displayed frames-per-second, total particle count and overflow (called by the
   * render loop). `overflow` is births lost to full emitters since the last stop/rewind - shown
   * as `-` when unknown (every visible emitter GPU-driven), flagged as a warning when nonzero, and
   * its tooltip says so when some GPU-driven emitter is left out of it.
   */
  report(fps: number, particles: number, overflow?: ParticleOverflow): void;
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
  const overflowValue = createElement("span", {
    className: "viewport-stats__value",
    textContent: "-",
  });
  attachTooltip(overflowValue, t("stats.overflow"), t("stats.overflowTip"));
  // Whether the tooltip currently carries the partial note - re-attached only when that flips.
  let overflowPartial = false;
  const costValue = createElement("span", {
    className: "viewport-stats__value",
    textContent: "-",
  });
  const element = createElement("div", { className: "viewport-stats" }, [
    createElement("div", { className: "viewport-stats__title", textContent: t("stats.title") }),
    statRow(fpsValue, t("field.fps")),
    statRow(particlesValue, t("stats.particles")),
    statRow(overflowValue, t("stats.overflow")),
    statRow(costValue, t("stats.totalCost")),
  ]);

  return {
    element,
    report(fps: number, particles: number, overflow?: ParticleOverflow): void {
      fpsValue.textContent = String(Math.round(fps));
      particlesValue.textContent = particles.toLocaleString("en-US");
      overflowValue.textContent =
        overflow === undefined ? "-" : overflow.count.toLocaleString("en-US");
      overflowValue.classList.toggle(
        "viewport-stats__value--warning",
        overflow !== undefined && overflow.count > 0,
      );
      const partial = overflow?.partial === true;
      if (partial !== overflowPartial) {
        overflowPartial = partial;
        attachTooltip(
          overflowValue,
          t("stats.overflow"),
          partial
            ? `${t("stats.overflowTip")} ${t("stats.overflowPartialTip")}`
            : t("stats.overflowTip"),
        );
      }
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
