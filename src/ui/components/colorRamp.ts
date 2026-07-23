/**
 * A color-ramp (gradient) editor: a preview bar with draggable stop handles, plus an
 * inline editor for the selected stop (a {@link ColorPicker} swatch, a position field and a
 * delete button). Clicking an empty spot on the bar inserts a stop with the interpolated
 * color; dragging a handle moves it; a stop can be removed down to a single one.
 *
 * The selection + emit + teardown state machine lives in {@link HandleListEditor}; this class owns
 * the 1D bar, its handles and the selected-stop editor.
 *
 * Presentational and in the engine's color model: it takes and emits a {@link RampGradient} whose
 * stop colors are linear RGBA (`[r, g, b, a]`, each `0..1`) - the exact shape a `color-ramp` node's
 * `gradient` param carries. `onChange` fires once per gesture (see {@link HandleListEditor.emit});
 * `live` fires on every intermediate step instead. `setValue` re-syncs from external state (undo /
 * redo) without firing.
 */

import { t } from "../../i18n";
import { createElement } from "../dom";
import { glyphIcons, icon } from "../icons";
import { fractionAcross } from "../primitives/geometry";
import { clamp01 } from "../primitives/math";
import { cssRgba, linearToSrgbRgba, type Rgba } from "./color";
import { ColorPicker } from "./colorPicker";
import { HandleListEditor } from "./handleListEditor";
import { NumberControl } from "./numberControl";

/** One stop: a normalized position and a **linear** RGBA color. Mirrors the engine shape. */
export interface RampStop {
  readonly position: number;
  readonly color: Rgba;
}

/** A gradient as authored data - the value a `color-ramp` node's `gradient` param carries. */
export interface RampGradient {
  readonly stops: readonly RampStop[];
}

export interface ColorRampConfig {
  readonly value: RampGradient;
  /** Fires once, with the final gradient, at the end of a gesture (see the class doc). */
  readonly onChange: (value: RampGradient) => void;
  /** Fires with the in-progress gradient on every intermediate drag step (see the class doc). */
  readonly live?: ((value: RampGradient) => void) | undefined;
}

/** The mutable working stop the editor drags and edits in place. */
interface Stop {
  position: number;
  color: Rgba;
}

/** Piecewise-linear sample of `stops` at `position` (linear RGBA), matching the node's baked eval. */
function sampleGradient(stops: readonly RampStop[], position: number): Rgba {
  if (stops.length === 0) {
    return [1, 1, 1, 1];
  }
  const sorted = [...stops].sort((a, b) => a.position - b.position);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error("gradient sample: sorted stops must be non-empty after the length check");
  }
  if (position <= first.position) {
    return first.color;
  }
  if (position >= last.position) {
    return last.color;
  }
  let i = 0;
  while (i < sorted.length - 1) {
    const next = sorted[i + 1];
    if (next === undefined || next.position > position) {
      break;
    }
    i++;
  }
  const lowerStop = sorted[i];
  const upperStop = sorted[i + 1];
  if (lowerStop === undefined || upperStop === undefined) {
    throw new Error("gradient sample: index out of range while bracketing the position");
  }
  const span = upperStop.position - lowerStop.position;
  const fraction = span <= 1e-6 ? 0 : (position - lowerStop.position) / span;
  return [
    lowerStop.color[0] + (upperStop.color[0] - lowerStop.color[0]) * fraction,
    lowerStop.color[1] + (upperStop.color[1] - lowerStop.color[1]) * fraction,
    lowerStop.color[2] + (upperStop.color[2] - lowerStop.color[2]) * fraction,
    lowerStop.color[3] + (upperStop.color[3] - lowerStop.color[3]) * fraction,
  ];
}

/** CSS color for a linear-RGBA stop (converted to sRGB for display). */
function stopCss(color: Rgba): string {
  const [r, g, b, alpha] = linearToSrgbRgba(color);
  return cssRgba([r, g, b], alpha);
}

export class ColorRamp extends HandleListEditor<Stop, RampGradient> {
  public readonly element: HTMLElement;

  private readonly bar: HTMLElement;
  private readonly stopsLayer: HTMLElement;
  private readonly editorHost: HTMLElement;

  /** The selected stop's live editor parts, so an in-place repaint can update them. */
  private positionControl: NumberControl | undefined;
  private picker: ColorPicker | undefined;

  constructor(config: ColorRampConfig) {
    super(config.onChange, config.live);
    this.items = this.normalize(config.value);

    this.bar = createElement("div", { className: "color-ramp__bar" });
    this.bar.addEventListener("pointerdown", (event) => {
      // A press on the bar itself (not on a handle) adds a stop at that position.
      if (event.target === this.bar) {
        event.stopPropagation();
        this.addStopAt(this.fractionAt(event.clientX));
      }
    });
    this.stopsLayer = createElement("div", { className: "color-ramp__stops" });
    const barWrap = createElement("div", { className: "color-ramp__bar-wrap" }, [
      this.bar,
      this.stopsLayer,
    ]);
    this.editorHost = createElement("div", { className: "color-ramp__editor" });
    this.element = createElement("div", { className: "color-ramp" }, [barWrap, this.editorHost]);
    // Editing on the ramp must never start a node drag / marquee.
    this.element.addEventListener("pointerdown", (event) => event.stopPropagation());

    this.render();
  }

  protected get handleContainer(): HTMLElement {
    return this.stopsLayer;
  }

  protected get selectedHandleClass(): string {
    return "color-ramp__stop--selected";
  }

  protected normalize(value: RampGradient): Stop[] {
    // `value` is only shape-checked at the param boundary (isGradient): each stop's own fields
    // still need defaulting here, so treat them as unknown rather than trusting RampStop's types.
    const stops = (value.stops as readonly unknown[]).map((rawStop) => {
      const stop = rawStop as { position?: unknown; color?: readonly unknown[] };
      const color = stop.color;
      return {
        position: clamp01(typeof stop.position === "number" ? stop.position : 0),
        color: [
          (color?.[0] as number | undefined) ?? 0,
          (color?.[1] as number | undefined) ?? 0,
          (color?.[2] as number | undefined) ?? 0,
          (color?.[3] as number | undefined) ?? 1,
        ] as Rgba,
      };
    });
    return stops.length > 0 ? stops : [{ position: 0, color: [0, 0, 0, 1] as Rgba }];
  }

  protected serialize(): RampGradient {
    return { stops: this.items.map((stop) => ({ position: stop.position, color: stop.color })) };
  }

  protected disposeParts(): void {
    // Close the child picker's popover so it can't outlive the ramp, and release the number field.
    this.picker?.dispose();
    this.positionControl?.dispose();
  }

  /** Full rebuild: bar gradient, handles and the selected-stop editor. */
  protected render(): void {
    this.repaintBar();
    this.buildHandles();
    this.buildEditor();
  }

  protected buildEditor(): void {
    const stop = this.items[this.selected];
    this.editorHost.replaceChildren();
    // Dispose the previous selection's editor parts before rebuilding, so a reselect can't leak
    // the old picker's popover.
    this.picker?.dispose();
    this.positionControl?.dispose();
    this.positionControl = undefined;
    this.picker = undefined;
    if (stop === undefined) {
      return;
    }

    const applyColor = (rgba: Rgba, final: boolean): void => {
      const target = this.items[this.selected];
      if (target === undefined) {
        return;
      }
      target.color = rgba;
      this.repaintBar();
      this.updateSelectedHandleColor();
      this.emit(final);
    };
    this.picker = new ColorPicker({
      value: stop.color,
      alpha: true,
      live: (rgba): void => applyColor(rgba, false),
      onChange: (rgba): void => applyColor(rgba, true),
    });

    const positionLabel = createElement("span", {
      className: "param__label",
      textContent: t("field.position"),
    });
    const applyPosition = (next: number, final: boolean): void => {
      const target = this.items[this.selected];
      if (target === undefined) {
        return;
      }
      target.position = clamp01(next);
      this.buildHandles();
      this.repaintBar();
      this.emit(final);
    };
    this.positionControl = new NumberControl({
      value: stop.position,
      min: 0,
      max: 1,
      step: 0.01,
      compact: true,
      live: (next): void => applyPosition(next, false),
      onChange: (next): void => applyPosition(next, true),
    });

    const remove = createElement(
      "button",
      {
        className: "color-ramp__delete",
        type: "button",
        on: {
          click: (event) => {
            event.stopPropagation();
            this.deleteSelected();
          },
        },
      },
      [icon(glyphIcons.close)],
    );
    remove.disabled = this.items.length <= 1;

    this.editorHost.append(
      this.picker.element,
      positionLabel,
      this.positionControl.element,
      remove,
    );
  }

  private fractionAt(clientX: number): number {
    return fractionAcross(clientX, this.bar.getBoundingClientRect());
  }

  private addStopAt(position: number): void {
    const color = sampleGradient(this.items, position);
    this.items.push({ position, color });
    this.selected = this.items.length - 1;
    this.render();
    this.emit();
  }

  /** Repaints just the preview bar's gradient (cheap; used during a live drag). */
  private repaintBar(): void {
    const sorted = [...this.items].sort((a, b) => a.position - b.position);
    const segments = sorted.map((s) => `${stopCss(s.color)} ${(s.position * 100).toFixed(2)}%`);
    // A single stop has no span - repeat it so the bar shows a flat color.
    if (segments.length === 1) {
      const only = segments[0];
      if (only !== undefined) {
        segments.push(only);
      }
    }
    this.bar.style.background = `linear-gradient(to right, ${segments.join(", ")})`;
  }

  private buildHandles(): void {
    this.stopsLayer.replaceChildren();
    this.items.forEach((stop, index) => {
      const dot = createElement("span", { className: "color-ramp__stop-dot" });
      dot.style.background = stopCss(stop.color);
      const handle = createElement("div", { className: "color-ramp__stop" }, [dot]);
      handle.style.left = `${stop.position * 100}%`;
      handle.classList.toggle(this.selectedHandleClass, index === this.selected);
      this.attachHandleDrag(handle, index, (moveEvent) => {
        const item = this.items[index];
        if (item === undefined) {
          return;
        }
        item.position = this.fractionAt(moveEvent.clientX);
        handle.style.left = `${item.position * 100}%`;
        this.repaintBar();
        this.positionControl?.setValue(item.position);
      });
      this.stopsLayer.append(handle);
    });
  }

  private updateSelectedHandleColor(): void {
    const handle = this.stopsLayer.children[this.selected];
    const dot = handle?.firstElementChild;
    const stop = this.items[this.selected];
    if (dot instanceof HTMLElement && stop !== undefined) {
      dot.style.background = stopCss(stop.color);
    }
  }
}
