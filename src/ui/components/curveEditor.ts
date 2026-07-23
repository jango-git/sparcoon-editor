/**
 * A scalar-curve editor: an SVG plot of the curve with draggable anchor handles, plus an inline
 * editor for the selected anchor (position + value fields, a smooth/sharp toggle and a delete
 * button). Clicking an empty spot in the plot inserts an anchor on the curve at that position;
 * dragging a handle moves it in 2D (x = position, y = value); double-clicking a handle toggles
 * its smoothing. An anchor can be removed down to a single one.
 *
 * The selection + emit + teardown state machine lives in {@link HandleListEditor}; this class owns
 * the 2D SVG plot, its handles and the selected-anchor editor.
 *
 * Presentational and in the engine's curve model: it takes and emits a {@link CurveData} whose
 * points are `{ position, value, interpolation }` - the exact shape a Curve node's inline `curve` param
 * carries. The preview mirrors the node's baked evaluation (Catmull-Rom where both endpoints are
 * smooth, linear across a sharp corner). `onChange` fires once per gesture (see
 * {@link HandleListEditor.emit}); `live` fires on every intermediate step instead. `setValue`
 * re-syncs from external state (undo / redo) without firing.
 */

import { t } from "../../i18n";
import { createElement } from "../dom";
import { actionIcons } from "../icons";
import { field } from "../primitives/field";
import { fractionAcross } from "../primitives/geometry";
import { clamp, clamp01 } from "../primitives/math";
import { attachCountdownConfirm } from "./countdownConfirm";
import { HandleListEditor } from "./handleListEditor";
import { NumberControl } from "./numberControl";
import { attachTooltip } from "./tooltip";

/** How the curve passes through an anchor: a smooth (Catmull-Rom) join, or a sharp corner. */
export type CurveInterpolation = "smooth" | "sharp";

/** One anchor: a normalized position, an output value and a smoothing mode. Mirrors the engine shape. */
export interface CurvePoint {
  readonly position: number;
  readonly value: number;
  readonly interpolation: CurveInterpolation;
}

/** A curve as authored data - the value a Curve node's inline `curve` param carries. */
export interface CurveData {
  readonly points: readonly CurvePoint[];
  /**
   * The value-axis window [min, max] the editor plots against and lets the user set. Authoring
   * only - the engine bake reads just `points`; the coerce passes these through untouched. Absent
   * on a fresh / legacy curve, where the editor auto-fits the window to the data on first open.
   */
  readonly min?: number;
  readonly max?: number;
}

export interface CurveEditorConfig {
  readonly value: CurveData;
  /** Fires once, with the final curve, at the end of a gesture (see the class doc). */
  readonly onChange: (value: CurveData) => void;
  /** Fires with the in-progress curve on every intermediate drag step (see the class doc). */
  readonly live?: ((value: CurveData) => void) | undefined;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
/** Segments the preview polyline is drawn with (visual only; the node bakes its own sampling). */
const PREVIEW_STEPS = 64;
/** SVG-unit head/foot room so an anchor sitting exactly at the value min/max is not clipped by the frame. */
const PLOT_INSET = 6;
/** Clicks to confirm an anchor delete: one, so the guarded-trash control matches the app's delete look. */
const DELETE_CLICKS = 1;

interface Anchor {
  position: number;
  value: number;
  interpolation: CurveInterpolation;
}

/** Catmull-Rom slope (dy/dx) at `i` from neighbour finite differences (one-sided at the ends). */
function slopeAt(anchors: readonly Anchor[], i: number): number {
  const current = anchors[i];
  if (current === undefined) {
    throw new Error("Slope requested for an anchor index outside the curve");
  }
  const previousAnchor = anchors[i - 1] ?? current;
  const nextAnchor = anchors[i + 1] ?? current;
  const deltaPosition = nextAnchor.position - previousAnchor.position;
  return deltaPosition > 1e-6 ? (nextAnchor.value - previousAnchor.value) / deltaPosition : 0;
}

/**
 * Samples the curve at `position` - the same rule the node bakes: cubic Hermite (Catmull-Rom
 * tangents) across a segment whose endpoints are both smooth, otherwise linear; flat outside the
 * ends.
 */
function sampleCurve(sorted: readonly Anchor[], position: number): number {
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) {
    return 0;
  }
  if (position <= first.position) {
    return first.value;
  }
  if (position >= last.position) {
    return last.value;
  }
  let i = 0;
  while (i < sorted.length - 1) {
    const nextAnchor = sorted[i + 1];
    if (nextAnchor === undefined || nextAnchor.position > position) {
      break;
    }
    i++;
  }
  const lowerAnchor = sorted[i];
  const upperAnchor = sorted[i + 1];
  if (lowerAnchor === undefined || upperAnchor === undefined) {
    throw new Error("Curve segment search produced an anchor index outside the curve");
  }
  const span = upperAnchor.position - lowerAnchor.position;
  if (span <= 1e-6) {
    return upperAnchor.value;
  }
  const fraction = (position - lowerAnchor.position) / span;
  if (lowerAnchor.interpolation === "sharp" || upperAnchor.interpolation === "sharp") {
    return lowerAnchor.value + (upperAnchor.value - lowerAnchor.value) * fraction;
  }
  const startTangent = slopeAt(sorted, i) * span;
  const endTangent = slopeAt(sorted, i + 1) * span;
  const fractionSquared = fraction * fraction;
  const fractionCubed = fractionSquared * fraction;
  return (
    (2 * fractionCubed - 3 * fractionSquared + 1) * lowerAnchor.value +
    (fractionCubed - 2 * fractionSquared + fraction) * startTangent +
    (-2 * fractionCubed + 3 * fractionSquared) * upperAnchor.value +
    (fractionCubed - fractionSquared) * endTangent
  );
}

export class CurveEditor extends HandleListEditor<Anchor, CurveData> {
  public readonly element: HTMLElement;

  private readonly plot: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly curvePath: SVGPathElement;
  private readonly handlesLayer: HTMLElement;
  private readonly editorHost: HTMLElement;

  /** The value axis window: user-set via the min/max fields, persisted on the curve (see {@link readDomain}). */
  private domainMin = 0;
  private domainMax = 1;
  /** The selected anchor's live editor parts, so an in-place repaint can update them. */
  private positionControl: NumberControl | undefined;
  private valueControl: NumberControl | undefined;
  /** The value-range fields, kept so a range edit can rescale without disposing the field mid-scrub. */
  private minControl: NumberControl | undefined;
  private maxControl: NumberControl | undefined;

  constructor(config: CurveEditorConfig) {
    super(config.onChange, config.live);
    this.items = this.normalize(config.value);

    this.svg = document.createElementNS(SVG_NAMESPACE, "svg");
    this.svg.setAttribute("class", "curve-editor__plot");
    this.svg.setAttribute("viewBox", "0 0 100 100");
    this.svg.setAttribute("preserveAspectRatio", "none");
    this.curvePath = document.createElementNS(SVG_NAMESPACE, "path");
    this.curvePath.setAttribute("class", "curve-editor__line");
    this.svg.append(this.buildGrid(), this.curvePath);

    this.plot = createElement("div", { className: "curve-editor__plot-wrap" }, [this.svg]);
    this.plot.addEventListener("pointerdown", (event) => {
      // A press on the plot itself (not on a handle) inserts an anchor at that position.
      if (event.target === this.svg || event.target === this.plot) {
        event.stopPropagation();
        this.addPointAt(this.fractionAt(event.clientX));
      }
    });
    this.handlesLayer = createElement("div", { className: "curve-editor__handles" });
    this.plot.append(this.handlesLayer);

    // A column wrapper: it stacks the anchor row and the value-range row (each a flex row of its
    // own). The host must NOT be `curve-editor__editor` - that class is a flex row, which would lay
    // the two rows out side by side and overflow the node.
    this.editorHost = createElement("div", { className: "curve-editor__settings" });
    this.element = createElement("div", { className: "curve-editor" }, [
      this.plot,
      this.editorHost,
    ]);
    // Editing on the plot must never start a node drag / marquee.
    this.element.addEventListener("pointerdown", (event) => event.stopPropagation());

    this.render();
  }

  protected get handleContainer(): HTMLElement {
    return this.handlesLayer;
  }

  protected get selectedHandleClass(): string {
    return "curve-editor__handle--selected";
  }

  protected normalize(value: CurveData): Anchor[] {
    // `value` is only shape-checked at the param boundary (isCurve): each point's own fields
    // still need defaulting here, so treat them as unknown rather than trusting CurvePoint's types.
    const anchors = (value.points as readonly unknown[]).map((rawPoint) => {
      const point = rawPoint as { position?: unknown; value?: unknown; interpolation?: unknown };
      return {
        position: clamp01(typeof point.position === "number" ? point.position : 0),
        value: typeof point.value === "number" ? point.value : 0,
        interpolation: point.interpolation === "sharp" ? ("sharp" as const) : ("smooth" as const),
      };
    });
    const result: Anchor[] =
      anchors.length > 0 ? anchors : [{ position: 0, value: 0, interpolation: "smooth" }];
    this.readDomain(value, result);
    return result;
  }

  protected serialize(): CurveData {
    return {
      points: this.items.map((anchor) => ({
        position: anchor.position,
        value: anchor.value,
        interpolation: anchor.interpolation,
      })),
      min: this.domainMin,
      max: this.domainMax,
    };
  }

  protected disposeParts(): void {
    // Release the child number fields (no popovers here, but they may hold a live scrub drag).
    this.positionControl?.dispose();
    this.valueControl?.dispose();
    this.minControl?.dispose();
    this.maxControl?.dispose();
  }

  /** Full rebuild: curve path, handles and the selected-anchor editor (the domain is user-set). */
  protected render(): void {
    this.repaintCurve();
    this.buildHandles();
    this.buildEditor();
  }

  protected buildEditor(): void {
    const anchor = this.items[this.selected];
    this.editorHost.replaceChildren();
    // Release the previous selection's number fields before rebuilding them.
    this.positionControl?.dispose();
    this.valueControl?.dispose();
    this.minControl?.dispose();
    this.maxControl?.dispose();
    this.positionControl = undefined;
    this.valueControl = undefined;
    this.minControl = undefined;
    this.maxControl = undefined;

    const rangeRow = this.buildRangeRow();
    if (anchor === undefined) {
      this.editorHost.append(rangeRow);
      return;
    }

    const applyPosition = (next: number, final: boolean): void => {
      const target = this.items[this.selected];
      if (target === undefined) {
        return;
      }
      target.position = clamp01(next);
      this.render();
      this.emit(final);
    };
    this.positionControl = new NumberControl({
      value: anchor.position,
      min: 0,
      max: 1,
      step: 0.01,
      compact: true,
      live: (next): void => applyPosition(next, false),
      onChange: (next): void => applyPosition(next, true),
    });

    // Unbounded so a range rescale can push the shown value past the old window without a false
    // clamp; typed / dragged edits are clamped to the window at their own call sites instead.
    const applyAnchorValue = (next: number, final: boolean): void => {
      const target = this.items[this.selected];
      if (target === undefined) {
        return;
      }
      target.value = clamp(next, this.domainMin, this.domainMax);
      this.render();
      this.emit(final);
    };
    this.valueControl = new NumberControl({
      value: anchor.value,
      step: 0.01,
      compact: true,
      live: (next): void => applyAnchorValue(next, false),
      onChange: (next): void => applyAnchorValue(next, true),
    });

    const interpolationToggle = createElement("button", {
      className: "curve-editor__interpolation",
      textContent: anchor.interpolation === "smooth" ? t("curve.smooth") : t("curve.sharp"),
      type: "button",
      on: {
        click: (event) => {
          event.stopPropagation();
          this.toggleInterpolation(this.selected);
        },
      },
    });
    attachTooltip(interpolationToggle, t("curve.interpolation"), t("curve.toggleTip"));

    // The app-wide delete affordance: a danger-tinted trash guarded by the countdown-confirm control
    // (one click here), the same button used for timeline row removes.
    const remove = createElement("button", { className: "curve-editor__delete confirm-danger" });
    remove.type = "button";
    remove.innerHTML = actionIcons.trash;
    remove.disabled = this.items.length <= 1;
    attachTooltip(remove, t("curve.remove"), t("curve.removeTip"));
    attachCountdownConfirm(remove, actionIcons.trash, DELETE_CLICKS, () => this.deleteSelected());

    const anchorFields = createElement("div", { className: "curve-editor__group" }, [
      labelled(t("curve.x"), this.positionControl.element),
      labelled(t("curve.y"), this.valueControl.element),
    ]);
    const anchorActions = createElement("div", { className: "curve-editor__group" }, [
      interpolationToggle,
      remove,
    ]);
    // Selected anchor first (next to the plot it edits), the value-window row below it.
    this.editorHost.append(
      createElement("div", { className: "curve-editor__editor" }, [anchorFields, anchorActions]),
      rangeRow,
    );
  }

  /**
   * Sets the value-axis window from the stored range, or - for a fresh/legacy curve with none -
   * auto-fits it to the data once (always spanning at least 0..1) so the two fields open populated.
   */
  private readDomain(value: CurveData, anchors: readonly Anchor[]): void {
    if (typeof value.min === "number" && typeof value.max === "number" && value.max > value.min) {
      this.domainMin = value.min;
      this.domainMax = value.max;
      return;
    }
    let min = 0;
    let max = 1;
    for (const anchor of anchors) {
      min = Math.min(min, anchor.value);
      max = Math.max(max, anchor.value);
    }
    this.domainMin = min;
    this.domainMax = max;
  }

  private fractionAt(clientX: number): number {
    return fractionAcross(clientX, this.plot.getBoundingClientRect());
  }

  /** Pointer y mapped into the current value domain (unclamped; the caller clamps to the window). */
  private valueAt(clientY: number): number {
    const rectangle = this.plot.getBoundingClientRect();
    if (rectangle.height === 0) {
      return this.domainMin;
    }
    const usable = 100 - 2 * PLOT_INSET;
    const svgY = ((clientY - rectangle.top) / rectangle.height) * 100;
    const fraction = 1 - (svgY - PLOT_INSET) / usable;
    return this.domainMin + fraction * (this.domainMax - this.domainMin);
  }

  private addPointAt(position: number): void {
    // Sit the new anchor exactly on the current curve so inserting never kinks it.
    const value = sampleCurve(
      [...this.items].sort((a, b) => a.position - b.position),
      position,
    );
    this.items.push({ position, value, interpolation: "smooth" });
    this.selected = this.items.length - 1;
    this.render();
    this.emit();
  }

  private toggleInterpolation(index: number): void {
    const anchor = this.items[index];
    if (anchor === undefined) {
      return;
    }
    anchor.interpolation = anchor.interpolation === "smooth" ? "sharp" : "smooth";
    this.render();
    this.emit();
  }

  /**
   * Re-windows the value axis to `[nextMin, nextMax]`, rescaling every anchor so its fractional
   * height in the window is preserved - the plotted shape does not move, only the numbers behind it
   * do (e.g. window 0..1 with a 0.5 anchor -> window 0..2 makes it 1.0). A lightweight in-place
   * update (no editor rebuild) so scrubbing a range field stays smooth. `final` follows the caller:
   * a min/max field's own live/commit split, or `true` directly for the discrete "normalize" button.
   */
  private setValueRange(nextMin: number, nextMax: number, final: boolean): void {
    const oldSpan = this.domainMax - this.domainMin;
    if (oldSpan > 1e-9) {
      const newSpan = nextMax - nextMin;
      for (const anchor of this.items) {
        anchor.value = nextMin + ((anchor.value - this.domainMin) / oldSpan) * newSpan;
      }
    }
    this.domainMin = nextMin;
    this.domainMax = nextMax;
    this.repaintCurve();
    this.repositionHandles();
    this.minControl?.setValue(nextMin);
    this.maxControl?.setValue(nextMax);
    const selectedAnchor = this.items[this.selected];
    if (selectedAnchor !== undefined) {
      this.valueControl?.setValue(selectedAnchor.value);
    }
    this.emit(final);
  }

  /** SVG y (0..100, top-down) for a value in the current domain, inset so end anchors stay in frame. */
  private toSvgY(value: number): number {
    const span = this.domainMax - this.domainMin;
    const fraction = span <= 1e-6 ? 0.5 : (value - this.domainMin) / span;
    return PLOT_INSET + (1 - fraction) * (100 - 2 * PLOT_INSET);
  }

  /** Repaints just the curve polyline (cheap; used during a live drag). */
  private repaintCurve(): void {
    const sorted = [...this.items].sort((a, b) => a.position - b.position);
    let pathData = "";
    for (let i = 0; i <= PREVIEW_STEPS; i++) {
      const position = i / PREVIEW_STEPS;
      const x = (position * 100).toFixed(2);
      const y = this.toSvgY(sampleCurve(sorted, position)).toFixed(2);
      pathData += `${i === 0 ? "M" : "L"}${x} ${y} `;
    }
    this.curvePath.setAttribute("d", pathData.trim());
  }

  private buildHandles(): void {
    this.handlesLayer.replaceChildren();
    this.items.forEach((anchor, index) => {
      const handle = createElement("div", {
        className: `curve-editor__handle curve-editor__handle--${anchor.interpolation}`,
      });
      this.placeHandle(handle, anchor);
      handle.classList.toggle(this.selectedHandleClass, index === this.selected);
      this.attachHandleDrag(handle, index, (moveEvent) => {
        const point = this.items[index];
        if (point === undefined) {
          return;
        }
        point.position = this.fractionAt(moveEvent.clientX);
        // The window is user-set now, so a drag stays inside it rather than widening it.
        point.value = clamp(this.valueAt(moveEvent.clientY), this.domainMin, this.domainMax);
        this.repaintCurve();
        this.repositionHandles();
        this.positionControl?.setValue(point.position);
        this.valueControl?.setValue(point.value);
      });
      handle.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        this.toggleInterpolation(index);
      });
      this.handlesLayer.append(handle);
    });
  }

  private placeHandle(handle: HTMLElement, anchor: Anchor): void {
    handle.style.left = `${clamp01(anchor.position) * 100}%`;
    handle.style.top = `${this.toSvgY(anchor.value)}%`;
  }

  /** Repositions the existing handles in place (during a drag; avoids rebuilding the pressed one). */
  private repositionHandles(): void {
    Array.from(this.handlesLayer.children).forEach((child, index) => {
      const anchor = this.items[index];
      if (child instanceof HTMLElement && anchor !== undefined) {
        this.placeHandle(child, anchor);
      }
    });
  }

  /** The value-window row (second): the min/max fields, plus a normalize back to a 0..1 window. */
  private buildRangeRow(): HTMLElement {
    this.minControl = new NumberControl({
      value: this.domainMin,
      step: 0.01,
      compact: true,
      // Keep a non-degenerate window: min can rise only up to just under max.
      live: (next): void =>
        this.setValueRange(Math.min(next, this.domainMax - 1e-3), this.domainMax, false),
      onChange: (next): void =>
        this.setValueRange(Math.min(next, this.domainMax - 1e-3), this.domainMax, true),
    });
    this.maxControl = new NumberControl({
      value: this.domainMax,
      step: 0.01,
      compact: true,
      live: (next): void =>
        this.setValueRange(this.domainMin, Math.max(next, this.domainMin + 1e-3), false),
      onChange: (next): void =>
        this.setValueRange(this.domainMin, Math.max(next, this.domainMin + 1e-3), true),
    });
    const normalize = createElement("button", {
      className: "curve-editor__normalize",
      textContent: t("curve.normalize"),
      type: "button",
      // Rescale the window back to 0..1; the shape is preserved (setValueRange rescales the anchors).
      on: {
        click: (event) => {
          event.stopPropagation();
          this.setValueRange(0, 1, true);
        },
      },
    });
    attachTooltip(normalize, t("curve.normalize"), t("curve.normalizeTip"));
    const rangeFields = createElement("div", { className: "curve-editor__group" }, [
      labelled(t("curve.min"), this.minControl.element),
      labelled(t("curve.max"), this.maxControl.element),
    ]);
    return createElement("div", { className: "curve-editor__range" }, [rangeFields, normalize]);
  }

  private buildGrid(): SVGGElement {
    const group = document.createElementNS(SVG_NAMESPACE, "g");
    group.setAttribute("class", "curve-editor__grid");
    // Frame + quartile guides in viewBox units (stretched by preserveAspectRatio="none").
    for (const x of [25, 50, 75]) {
      group.append(gridLine(x, 0, x, 100));
    }
    for (const y of [25, 50, 75]) {
      group.append(gridLine(0, y, 100, y));
    }
    return group;
  }
}

function gridLine(x1: number, y1: number, x2: number, y2: number): SVGLineElement {
  const line = document.createElementNS(SVG_NAMESPACE, "line");
  line.setAttribute("x1", String(x1));
  line.setAttribute("y1", String(y1));
  line.setAttribute("x2", String(x2));
  line.setAttribute("y2", String(y2));
  return line;
}

/** A small caption + control, for the selected-anchor editor row. */
function labelled(text: string, control: HTMLElement): HTMLElement {
  return field(text, control, {
    tag: "span",
    rowClassName: "curve-editor__field",
    labelClassName: "curve-editor__field-label",
  });
}
