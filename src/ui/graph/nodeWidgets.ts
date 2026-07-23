/**
 * The value-editing half of a node card: builds the inline parameter/socket controls, keeps them
 * in sync with the model on undo/redo, and reshapes a type-polymorphic ("generic") field when its
 * sibling `type` parameter changes. {@link NodeView} owns the card's structure and delegates every
 * control to a {@link NodeWidgets} instance, which also disposes them (closing popovers) when the
 * card is dropped.
 *
 * Each builder registers a syncer under its parameter key (re-syncing skips a field the user is actively
 * editing, e.g. a focused text input) and tracks its disposable widget. Controls emit via the
 * caller-supplied `emit` closure, which the dispatch methods wire to `onParamChange`.
 */

import type { GraphNode } from "../../domain/graphModel";
import type { FXNodeMeta, FXParamMeta, FXSocketMeta } from "../../domain/nodePalette";
import { humanizeKey } from "../../domain/nodePalette";
import { createElement } from "../dom";
import { t } from "../../i18n";
import type { UiComponent } from "../primitives/component";
import { NumberControl } from "../components/numberControl";
import { Dropdown } from "../components/dropdown";
import { ColorPicker } from "../components/colorPicker";
import { ColorRamp, type RampGradient } from "../components/colorRamp";
import { CurveEditor, type CurveData } from "../components/curveEditor";
import type { Rgba } from "../components/color";
import type { ParamChangeHandler } from "./nodeView";

/**
 * The `valueType` option that edits with a color picker. `"color"` is a UI alias for `vec4`
 * (color == vec4 in the engine): a `constant` typed `color` shows a picker, one typed `vec4`
 * shows four raw fields - same stored value, an explicit editor choice. A plain `vec4` is
 * NEVER implicitly a color; a socket that wants a picker opts in with `color: true`.
 */
const COLOR_TYPE = "color";

interface NumberBounds {
  min?: number | undefined;
  max?: number | undefined;
  step?: number | undefined;
}

export class NodeWidgets {
  private readonly paramSyncers = new Map<string, (value: unknown) => void>();
  /** Every child widget this factory owns, disposed together in {@link dispose}. */
  private readonly widgets: UiComponent[] = [];
  /**
   * For a type-polymorphic source (e.g. `constant`): the `generic` value parameter key, the
   * `valueType` parameter key that decides its width, and the live value control element. When
   * the type changes, the value control is rebuilt to the new arity (1 field / 2-4 fields).
   */
  private readonly genericValueKey: string | undefined;
  private readonly genericTypeKey: string | undefined;
  private genericValueControl: HTMLElement | undefined;

  constructor(
    metadata: FXNodeMeta | undefined,
    private readonly onParamChange?: ParamChangeHandler,
    /** Fires on every intermediate drag step of a scrub control - omitted entirely for a
     *  behavior-graph node (see `graphCanvas.ts`'s wiring), which then reports nothing until the
     *  gesture's final `onParamChange`. */
    private readonly onLiveParamChange?: ParamChangeHandler,
  ) {
    const allParameters = metadata === undefined ? [] : Object.entries(metadata.params);
    const genericTypeParam = allParameters.find(
      ([, parameter]) => parameter.kind === "structural" && parameter.type === "valueType",
    );
    this.genericTypeKey = genericTypeParam?.[0];
    // The generic value is either a body parameter (an `timeline-value`'s live `value`) or an
    // editable input socket (a `constant`'s inline `value`); either way its editor's arity
    // follows the sibling `type` parameter and reshapes with it. The socket arrives here already
    // type-resolved ("T" -> vec4/color-as-vec4), so key off "the lone editable input of a
    // typed node" rather than a "T" that resolution has erased - else a color constant would
    // lose its picker and reshape/overlay wiring.
    this.genericValueKey =
      allParameters.find(
        ([, parameter]) => parameter.kind === "value" && parameter.type === "generic",
      )?.[0] ??
      (this.genericTypeKey === undefined
        ? undefined
        : (metadata?.inputs ?? []).find((socket) => socket.control !== undefined)?.key);
  }

  /** Registers a parameter syncer (used by the card's hand-built rows, e.g. the parameter name field). */
  public registerSyncer(key: string, sync: (value: unknown) => void): void {
    this.paramSyncers.set(key, sync);
  }

  /** Adopts a disposable widget built outside the factory (e.g. an attribute/texture dropdown). */
  public track(widget: UiComponent): void {
    this.widgets.push(widget);
  }

  /** Re-syncs every control from the node's params. */
  public sync(node: GraphNode): void {
    for (const [key, sync] of this.paramSyncers) {
      sync(node.parameters[key]);
    }
  }

  /** Releases every child widget (closing any open popover) when the card is dropped. */
  public dispose(): void {
    for (const widget of this.widgets) {
      widget.dispose();
    }
    this.widgets.length = 0;
  }

  /** The editor for one body parameter, dispatched by its kind/type (and the generic reshape hook). */
  public createParamControl(node: GraphNode, key: string, parameter: FXParamMeta): HTMLElement {
    const value = node.parameters[key] ?? parameter.default;
    const emit = (next: unknown): void => this.onParamChange?.(key, next);
    const live = this.liveHandlerFor(key);

    if (parameter.kind === "structural" && parameter.type === "flag") {
      return this.checkbox(key, value === true, emit);
    }
    if (parameter.kind === "structural" && parameter.type === "gradient") {
      const gradient = isGradient(value) ? value : parameter.default;
      return this.gradientField(key, gradient, emit, live);
    }
    if (parameter.kind === "structural" && parameter.type === "curve") {
      const curve = isCurve(value) ? value : (parameter.default as CurveData);
      return this.curveField(key, curve, emit, live);
    }
    if (parameter.kind === "structural" && key === this.genericTypeKey) {
      // Changing the type reshapes the sibling generic value control (1 field <-> 2-4 fields,
      // or a color picker for the `color` alias).
      return this.select(key, parameter.options, String(value), (next) => {
        emit(next);
        this.reshapeGenericValue(String(next));
      });
    }
    if (parameter.kind === "structural") {
      // enum | valueType - a fixed option list.
      return this.select(key, parameter.options, String(value), emit);
    }
    // kind === "value"
    if (parameter.type === "float") {
      return this.numberField(
        key,
        toNumber(value, 0),
        { min: parameter.min, max: parameter.max, step: parameter.step },
        emit,
        live,
      );
    }
    if (parameter.type === "vec2" || parameter.type === "vec3" || parameter.type === "vec4") {
      const width = parameter.type === "vec2" ? 2 : parameter.type === "vec3" ? 3 : 4;
      // A vec parameter may carry per-component bounds (e.g. a color's 0..1 RGBA fields).
      return this.vectorField(
        key,
        toNumberArray(value, width),
        { min: parameter.min, max: parameter.max, step: parameter.step },
        emit,
        live,
      );
    }
    // Tautological today (the value-kind type union ends at "generic") - kept explicit so a
    // future value-kind type falls to the placeholder below instead of silently misrendering.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (parameter.type === "generic") {
      // Arity follows the node's chosen `type`, not the value's current shape, so a fresh
      // vec3 constant shows three fields even while its value is still the scalar default.
      const control = this.buildGenericControl(node, key, value);
      this.genericValueControl = control;
      return control;
    }
    // curve (and any future kind): a placeholder until the curve editor is wired.
    return this.placeholder(key, "curve");
  }

  /** The value control for an editable input socket (float / vecN / generic), by its type. */
  public createSocketControl(node: GraphNode, socket: FXSocketMeta): HTMLElement {
    const { control } = socket;
    if (control === undefined) {
      throw new Error("createSocketControl requires a socket with a control descriptor");
    }
    const value = node.parameters[socket.key] ?? control.default;
    const bounds = { min: control.min, max: control.max, step: control.step };
    const emit = (next: unknown): void => this.onParamChange?.(socket.key, next);
    const live = this.liveHandlerFor(socket.key);
    if (socket.type === "float") {
      return this.numberField(socket.key, toNumber(value, 0), bounds, emit, live);
    }
    // The node's own generic value pin (a `constant`): route it through the type-parameter-driven
    // builder before the vecN branch, else type resolution's "T" -> vec4 would render raw fields
    // and swallow the `color` alias (picker) / the reshape+overlay wiring keyed off this control.
    if (socket.key === this.genericValueKey) {
      const generic = this.buildGenericControl(node, socket.key, value);
      this.genericValueControl = generic;
      return generic;
    }
    // A picker only when the socket explicitly opts in with `color: true` (RGBA for vec4,
    // RGB for vec3); a plain vecN is never implicitly a color and renders raw component fields.
    if (control.color === true && (socket.type === "vec4" || socket.type === "vec3")) {
      const withAlpha = socket.type === "vec4";
      return this.colorField(
        socket.key,
        toNumberArray(value, withAlpha ? 4 : 3),
        withAlpha,
        emit,
        live,
      );
    }
    if (socket.type === "vec2" || socket.type === "vec3" || socket.type === "vec4") {
      const width = socket.type === "vec2" ? 2 : socket.type === "vec3" ? 3 : 4;
      return this.vectorField(socket.key, toNumberArray(value, width), bounds, emit, live);
    }
    // A generic (`"T"`) input sizes to the node's `type` parameter and reshapes when it changes.
    const generic = this.buildGenericControl(node, socket.key, value);
    this.genericValueControl = generic;
    return generic;
  }

  /** The `live` callback for `key`, or genuinely `undefined` (not a no-op closure) when no live
   *  channel is wired (a behavior-graph node) - so each control's own "omit live" check still works. */
  private liveHandlerFor(key: string): ((value: unknown) => void) | undefined {
    const onLiveParamChange = this.onLiveParamChange;
    return onLiveParamChange === undefined
      ? undefined
      : (next: unknown): void => onLiveParamChange(key, next);
  }

  /**
   * Whether a generic value of the given `type` edits with a color picker: only the explicit
   * `color` option. A plain `vec4` is never implicitly a color - it shows four raw fields, so a
   * node that wants a picker offers `color` as a distinct `valueType` option (e.g. `constant`).
   */
  private isColorType(typeName: string | undefined): boolean {
    return typeName === COLOR_TYPE;
  }

  /**
   * Builds a generic value/socket control sized by its sibling `type` parameter: a color picker
   * for a color type (see {@link isColorType}), else 1 field (`float`) or 2-4
   * (`vec2`/`vec3`/`vec4`). With no `type` parameter the width follows the current value's shape.
   */
  private buildGenericControl(node: GraphNode, key: string, value: unknown): HTMLElement {
    const emit = (next: unknown): void => this.onParamChange?.(key, next);
    const live = this.liveHandlerFor(key);
    const typeName =
      this.genericTypeKey === undefined ? undefined : String(node.parameters[this.genericTypeKey]);
    if (this.isColorType(typeName)) {
      return this.colorField(key, toNumberArray(value, 4), true, emit, live);
    }
    const width =
      typeName === undefined ? (Array.isArray(value) ? value.length : 1) : widthForType(typeName);
    return width > 1
      ? this.vectorField(key, toNumberArray(value, width), {}, emit, live)
      : this.numberField(key, toNumber(value, 0), {}, emit, live);
  }

  /**
   * Rebuilds the generic value control in place to match a newly chosen `type` and resets its
   * value to that type's default (a `vec4` color picker seeded opaque white, else a scalar `0`
   * or an N-vector of zeros), committing the reset so the stored value never lags the shown shape.
   */
  private reshapeGenericValue(typeName: string): void {
    const genericValueKey = this.genericValueKey;
    if (genericValueKey === undefined || this.genericValueControl === undefined) {
      return;
    }
    const emit = (next: unknown): void => this.onParamChange?.(genericValueKey, next);
    const live = this.liveHandlerFor(genericValueKey);
    const isColor = this.isColorType(typeName);
    const width = isColor ? 4 : widthForType(typeName);
    const reset = isColor ? [1, 1, 1, 1] : width > 1 ? Array<number>(width).fill(0) : 0;
    this.onParamChange?.(genericValueKey, reset);
    const control = isColor
      ? this.colorField(genericValueKey, [1, 1, 1, 1], true, emit, live)
      : width > 1
        ? this.vectorField(genericValueKey, Array<number>(width).fill(0), {}, emit, live)
        : this.numberField(genericValueKey, 0, {}, emit, live);
    this.genericValueControl.replaceWith(control);
    this.genericValueControl = control;
  }

  private numberField(
    key: string,
    value: number,
    bounds: NumberBounds,
    emit: (value: unknown) => void,
    live?: (value: unknown) => void,
  ): HTMLElement {
    const control = new NumberControl({
      value,
      min: bounds.min,
      max: bounds.max,
      step: bounds.step,
      onChange: (next): void => emit(next),
      live: live === undefined ? undefined : (next): void => live(next),
    });
    this.paramSyncers.set(key, (current) => {
      control.setValue(toNumber(current, value));
    });
    this.widgets.push(control);
    return control.element;
  }

  private vectorField(
    key: string,
    values: number[],
    bounds: NumberBounds,
    emit: (value: unknown) => void,
    live?: (value: unknown) => void,
  ): HTMLElement {
    const current = [...values];
    const controls: NumberControl[] = [];
    const container = createElement("div", { className: "param__vector" });
    current.forEach((component, index) => {
      const control = new NumberControl({
        value: component,
        compact: true,
        min: bounds.min,
        max: bounds.max,
        step: bounds.step,
        onChange: (next): void => {
          current[index] = next;
          emit([...current]);
        },
        live:
          live === undefined
            ? undefined
            : (next): void => {
                // A component's own live preview reports the whole vector (its siblings are the
                // committed values, since only this one component is mid-drag) - `current` already
                // holds them, updated below the same way `onChange` does above.
                const preview = [...current];
                preview[index] = next;
                live(preview);
              },
      });
      controls.push(control);
      this.widgets.push(control);
      container.append(control.element);
    });
    this.paramSyncers.set(key, (value) => {
      const next = toNumberArray(value, current.length);
      next.forEach((component, index) => {
        const control = controls[index];
        if (control !== undefined) {
          current[index] = component;
          control.setValue(component);
        }
      });
    });
    return container;
  }

  /** A color-ramp (gradient) editor for a `gradient` structural parameter. */
  private gradientField(
    key: string,
    value: RampGradient,
    emit: (value: unknown) => void,
    live?: (value: unknown) => void,
  ): HTMLElement {
    const ramp = new ColorRamp({
      value,
      onChange: (next): void => emit(next),
      live: live === undefined ? undefined : (next): void => live(next),
    });
    this.widgets.push(ramp);
    this.paramSyncers.set(key, (current) => {
      if (isGradient(current)) {
        ramp.setValue(current);
      }
    });
    return ramp.element;
  }

  /** A curve editor for an inline (`structural`) `curve` parameter. */
  private curveField(
    key: string,
    value: CurveData,
    emit: (value: unknown) => void,
    live?: (value: unknown) => void,
  ): HTMLElement {
    const editor = new CurveEditor({
      value,
      onChange: (next): void => emit(next),
      live: live === undefined ? undefined : (next): void => live(next),
    });
    this.widgets.push(editor);
    this.paramSyncers.set(key, (current) => {
      if (isCurve(current)) {
        editor.setValue(current);
      }
    });
    return editor.element;
  }

  /** A color-picker swatch for a color-flagged vec3/vec4 input (linear RGB(A)). */
  private colorField(
    key: string,
    values: number[],
    withAlpha: boolean,
    emit: (value: unknown) => void,
    live?: (value: unknown) => void,
  ): HTMLElement {
    const toParamValue = (rgba: Rgba): number[] =>
      withAlpha ? [...rgba] : [rgba[0], rgba[1], rgba[2]];
    const picker = new ColorPicker({
      value: toRgba(values),
      alpha: withAlpha,
      onChange: (rgba): void => emit(toParamValue(rgba)),
      live: live === undefined ? undefined : (rgba): void => live(toParamValue(rgba)),
    });
    this.paramSyncers.set(key, (current) => {
      picker.setValue(toRgba(toNumberArray(current, withAlpha ? 4 : 3)));
    });
    this.widgets.push(picker);
    return picker.element;
  }

  private select(
    key: string,
    options: readonly string[],
    value: string,
    emit: (value: unknown) => void,
  ): HTMLElement {
    const dropdown = new Dropdown({
      options: options.map((option) => ({ value: option, label: humanizeKey(option) })),
      value,
      onChange: (next): void => emit(next),
    });
    this.paramSyncers.set(key, (current) => dropdown.setValue(String(current)));
    this.widgets.push(dropdown);
    return dropdown.element;
  }

  private checkbox(key: string, checked: boolean, emit: (value: unknown) => void): HTMLElement {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "param__checkbox";
    input.checked = checked;
    input.addEventListener("change", () => emit(input.checked));
    this.paramSyncers.set(key, (current) => {
      input.checked = current === true;
    });
    return input;
  }

  private placeholder(key: string, kind: string): HTMLElement {
    const element = createElement("span", {
      className: "param__placeholder",
      textContent: kind === "curve" ? t("graph.curvePlaceholder") : `${kind}...`,
    });
    // No syncer: the value is not yet inline-editable.
    void key;
    return element;
  }
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && !Number.isNaN(value) ? value : fallback;
}

/** Pads/truncates a number array to a linear RGBA tuple (missing alpha defaults opaque). */
function toRgba(values: readonly number[]): Rgba {
  return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 1];
}

/** Whether an unknown parameter value has the gradient shape (`{ stops: [...] }`). */
function isGradient(value: unknown): value is RampGradient {
  return Array.isArray((value as { stops?: unknown } | undefined)?.stops);
}

/** Whether an unknown parameter value has the curve shape (`{ points: [...] }`). */
function isCurve(value: unknown): value is CurveData {
  return Array.isArray((value as { points?: unknown } | undefined)?.points);
}

/** Float-component count of a value-type name (`float`->1, ..., `vec4`/`color`->4); unknown->1. */
function widthForType(type: string): number {
  return type === "vec4" || type === "color" ? 4 : type === "vec3" ? 3 : type === "vec2" ? 2 : 1;
}

function toNumberArray(value: unknown, width: number): number[] {
  const source = Array.isArray(value) ? value : [];
  return Array.from({ length: width }, (_, index) => toNumber(source[index], 0));
}
