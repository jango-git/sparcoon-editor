/**
 * A color-picker control: a flat swatch button that opens a floating popover with a saturation/value
 * square, a hue slider, an alpha slider and a Hex/RGB/HSL value row (flat, sharp-cornered, accent on
 * interaction). The popover is screen-space (`position: fixed` at the swatch rectangle, appended to
 * `<body>` via the shared popover), so the graph canvas's pan/zoom never displaces it, mirroring
 * {@link Dropdown}. An optional {@link PaletteAccess} adds a full-height palette column on the
 * right: one row per saved color (preview, label, remove) over a full-width save button.
 *
 * Presentational and speaks the engine's color model: it takes and emits linear RGBA
 * (`[r, g, b, a]`, each `0..1`). Internally it holds sRGB HSV + alpha (what the hue wheel reads),
 * converting at the boundary; the Hex/RGB/HSL value row is three independent read/write views onto
 * that same HSV state, chosen by a mode toggle. `setValue` re-syncs from external state (undo /
 * redo) without firing. `onChange` fires exactly once per gesture - a slider drag's release, or a
 * single-shot hex/numeric edit - never per intermediate drag step; the optional `live` fires on
 * every intermediate slider step instead (omit it for no live preview at all during a drag).
 */

import { createElement } from "../dom";
import { t } from "../../i18n";
import type { PaletteSwatch } from "../../model/editorState";
import { actionIcons, glyphIcons, icon } from "../icons";
import type { ValueComponent } from "../primitives/component";
import { beginPointerDrag } from "../primitives/drag";
import { clamp01 } from "../primitives/math";
import { openPopover, type PopoverHandle } from "../primitives/popover";
import {
  cssRgba,
  hslToRgb,
  hsvToRgb,
  linearToSrgbRgba,
  parseHex,
  rgbToHex,
  rgbToHsl,
  rgbToHsv,
  srgbToLinearRgba,
  type Rgba,
} from "./color";
import { attachCountdownConfirm } from "./countdownConfirm";
import { NumberControl } from "./numberControl";
import { createSegmentedControl } from "./segmentedControl";
import { attachTooltip } from "./tooltip";

type ColorMode = "hex" | "rgb" | "hsl";

/** Presses to confirm removing a saved swatch - shorter than a content-library asset's guard
 *  (3-4 clicks): a palette color is a much cheaper thing to lose track of. */
const PALETTE_REMOVE_CLICKS = 2;

/**
 * Read/write bridge into the project's saved-color palette (a `SourceState` field like the HDRI
 * library - see `model/editorState.ts`'s {@link PaletteSwatch}), threaded in by whichever caller
 * holds a `Store` (see `paletteAccess.ts`'s factory) so this presentational component never
 * imports one itself. Omitted where nothing wires it up - the popover then shows no palette column.
 * The picker's palette panel is the only place the saved palette is listed or managed - there is no
 * separate library screen for it.
 */
export interface PaletteAccess {
  /** Read fresh on every popover open and after a save/remove, not resolved once - a swatch this
   *  same picker just saved shows up immediately, without needing the owner to rebuild the control. */
  readonly swatches: () => readonly PaletteSwatch[];
  readonly onSave: (color: Rgba, label: string) => void;
  readonly onRemove: (name: string) => void;
}

export interface ColorPickerConfig {
  /** Initial color as linear RGBA (each `0..1`). */
  readonly value: Rgba;
  /** Whether to expose the alpha channel (default true); when false, alpha is pinned to 1. */
  readonly alpha?: boolean;
  /** Fires once, with the final linear RGBA, at the end of a gesture (see the class doc). */
  readonly onChange: (value: Rgba) => void;
  /** Fires with the linear RGBA on every intermediate slider step (see the class doc). */
  readonly live?: ((value: Rgba) => void) | undefined;
  /** Saved-palette integration (see {@link PaletteAccess}); omit for a picker with no route back
   *  to the store. */
  readonly palette?: PaletteAccess | undefined;
}

export class ColorPicker implements ValueComponent<Rgba> {
  public readonly element: HTMLElement;

  private readonly swatchFill: HTMLElement;
  private readonly showAlpha: boolean;
  private popoverHandle: PopoverHandle | undefined;
  /** Cancels the live SV/hue/alpha slider drag, so dispose() can't leave window listeners live. */
  private activeDrag: (() => void) | undefined;
  /** Set while emitting `onChange`, so the re-render it triggers doesn't echo back mid-drag. */
  private suppressSync = false;

  // Working state: sRGB HSV + alpha (alpha is linear-independent).
  private hue = 0;
  private saturation = 0;
  private v = 0;
  private alpha = 1;

  /** Which value row is shown below the sliders; resets to "hex" per popover open (matches the
   *  picker's state before this mode toggle existed). */
  private colorMode: ColorMode = "hex";

  // Popover parts, live only while open.
  private saturationValueCursor: HTMLElement | undefined;
  private saturationValueArea: HTMLElement | undefined;
  private hueThumb: HTMLElement | undefined;
  private alphaThumb: HTMLElement | undefined;
  private alphaFill: HTMLElement | undefined;
  private preview: HTMLElement | undefined;
  private hexInput: HTMLInputElement | undefined;
  private valueHost: HTMLElement | undefined;
  /** The RGB/HSL row's numeric fields, torn down (their drag state included) on every mode switch
   *  and on dismiss - `hex` mode leaves this empty. */
  private componentControls: NumberControl[] = [];
  /** The palette column's row list (the save button beside it is static, never rebuilt). */
  private paletteList: HTMLElement | undefined;

  constructor(private readonly config: ColorPickerConfig) {
    this.showAlpha = config.alpha !== false;
    this.setFromLinear(config.value);

    this.swatchFill = createElement("span", { className: "color-swatch__fill" });
    this.element = createElement(
      "button",
      {
        className: "color-swatch param__input",
        type: "button",
        on: {
          click: (event) => {
            event.stopPropagation();
            this.toggle();
          },
          // Keep a press on the swatch from starting a node drag / marquee.
          pointerdown: (event) => event.stopPropagation(),
        },
      },
      [this.swatchFill],
    );
    this.syncSwatch();
  }

  /** Re-syncs the shown color from external state without firing `onChange`. */
  public setValue(value: Rgba): void {
    // Ignore the synchronous echo of our own edit (onChange -> owner re-render -> setValue):
    // reapplying it would drift HSV and fight the pointer during a slider drag.
    if (this.suppressSync) {
      return;
    }
    this.setFromLinear(value);
    this.syncSwatch();
    if (this.popoverHandle !== undefined) {
      this.renderPopover();
    }
  }

  public dispose(): void {
    this.activeDrag?.();
    this.activeDrag = undefined;
    this.popoverHandle?.close();
  }

  private setFromLinear(linear: Rgba): void {
    const [r, g, b, alpha] = linearToSrgbRgba(linear);
    const [hue, saturation, v] = rgbToHsv(r, g, b);
    // Preserve hue/sat when value collapses to black/greyscale (they're otherwise ambiguous),
    // so dragging value back up doesn't snap the hue to 0.
    this.hue = saturation === 0 ? this.hue : hue;
    this.saturation = v === 0 ? this.saturation : saturation;
    this.v = v;
    this.alpha = this.showAlpha ? alpha : 1;
  }

  /** Current sRGB `[r,g,b]` from the working HSV. */
  private srgb(): readonly [number, number, number] {
    return hsvToRgb(this.hue, this.saturation, this.v);
  }

  private currentLinear(): Rgba {
    const [r, g, b] = this.srgb();
    return srgbToLinearRgba([r, g, b, this.alpha]);
  }

  private syncSwatch(): void {
    this.swatchFill.style.background = cssRgba(this.srgb(), this.alpha);
  }

  /** `final: false` reports through `live` (an intermediate drag step, no-op if unwired); `true`
   *  reports through `onChange` (the gesture's one committing call). */
  private commit(final: boolean): void {
    this.syncSwatch();
    this.suppressSync = true;
    if (final) {
      this.config.onChange(this.currentLinear());
    } else {
      this.config.live?.(this.currentLinear());
    }
    this.suppressSync = false;
  }

  private toggle(): void {
    if (this.popoverHandle !== undefined) {
      this.popoverHandle.close();
    } else {
      this.open();
    }
  }

  private open(): void {
    const rectangle = this.element.getBoundingClientRect();
    const popover = createElement("div", {
      className: "color-picker",
      on: { pointerdown: (event) => event.stopPropagation() },
    });

    // Saturation/value square: hue-tinted, with white->right and black->bottom overlays.
    this.saturationValueArea = createElement("div", { className: "color-picker__sv" }, [
      createElement("div", { className: "color-picker__sv-white" }),
      createElement("div", { className: "color-picker__sv-black" }),
      (this.saturationValueCursor = createElement("div", {
        className: "color-picker__sv-cursor",
      })),
    ]);
    this.dragTarget(this.saturationValueArea, (x, y) => {
      this.saturation = clamp01(x);
      this.v = clamp01(1 - y);
      this.renderPopover();
    });

    // Hue slider (rainbow).
    this.hueThumb = createElement("div", { className: "color-picker__thumb" });
    const hueTrack = createElement("div", { className: "color-picker__hue" }, [this.hueThumb]);
    this.dragTarget(hueTrack, (x) => {
      this.hue = clamp01(x) * 360;
      this.renderPopover();
    });

    const sliders: HTMLElement[] = [hueTrack];
    if (this.showAlpha) {
      this.alphaThumb = createElement("div", { className: "color-picker__thumb" });
      this.alphaFill = createElement("div", { className: "color-picker__alpha-fill" });
      const alphaTrack = createElement("div", { className: "color-picker__alpha" }, [
        this.alphaFill,
        this.alphaThumb,
      ]);
      this.dragTarget(alphaTrack, (x) => {
        this.alpha = clamp01(x);
        this.renderPopover();
      });
      sliders.push(alphaTrack);
    }

    // Preview swatch + Hex/RGB/HSL value row, switched by the mode toggle.
    this.preview = createElement("div", { className: "color-picker__preview" });
    this.valueHost = createElement("div", { className: "color-picker__value" });
    const modeControl = createSegmentedControl<ColorMode>(
      [
        { key: "hex", label: t("colorPicker.modeHex") },
        { key: "rgb", label: t("colorPicker.modeRgb") },
        { key: "hsl", label: t("colorPicker.modeHsl") },
      ],
      this.colorMode,
      (mode) => {
        this.colorMode = mode;
        this.buildValueHost();
        this.renderPopover();
      },
    );
    modeControl.element.classList.add("color-picker__mode");
    const row = createElement("div", { className: "color-picker__row" }, [
      this.preview,
      this.valueHost,
    ]);

    const mainColumn = createElement("div", { className: "color-picker__main" }, [
      this.saturationValueArea,
      createElement("div", { className: "color-picker__sliders" }, sliders),
      modeControl.element,
      row,
    ]);
    popover.append(mainColumn);

    const palette = this.config.palette;
    if (palette !== undefined) {
      this.paletteList = createElement("div", { className: "color-picker__palette-list" });
      const addButton = createElement(
        "button",
        {
          className: "color-picker__palette-add",
          type: "button",
          on: {
            pointerdown: (event) => event.stopPropagation(),
            click: (event) => {
              event.stopPropagation();
              const label = rgbToHex(this.srgb(), this.showAlpha ? this.alpha : undefined);
              palette.onSave(this.currentLinear(), label);
              this.renderPaletteSwatches();
            },
          },
        },
        [icon(glyphIcons.plus)],
      );
      attachTooltip(addButton, t("colorPicker.saveSwatch"), t("colorPicker.saveSwatchTip"));
      popover.append(
        createElement("div", { className: "color-picker__palette" }, [this.paletteList, addButton]),
      );
    }

    this.element.classList.add("color-swatch--open");
    this.popoverHandle = openPopover(popover, {
      // A point 4px below the swatch, unclamped - the fixed-width picker hugs the swatch edge.
      anchor: { x: rectangle.left, y: rectangle.bottom + 4 },
      clampToViewport: false,
      ignore: this.element,
      onDismiss: () => {
        this.popoverHandle = undefined;
        this.saturationValueArea =
          this.saturationValueCursor =
          this.hueThumb =
          this.alphaThumb =
          this.alphaFill =
          this.preview =
          this.valueHost =
          this.paletteList =
            undefined;
        this.hexInput = undefined;
        this.componentControls.forEach((control) => control.dispose());
        this.componentControls = [];
        this.element.classList.remove("color-swatch--open");
      },
    });
    this.buildValueHost();
    this.renderPopover();
  }

  /** Rebuilds the value row for the current `colorMode` - the hex field, or the RGB/HSL numeric
   *  fields - tearing down whichever the previous mode left behind. */
  private buildValueHost(): void {
    if (this.valueHost === undefined) {
      return;
    }
    this.componentControls.forEach((control) => control.dispose());
    this.componentControls = [];
    this.hexInput = undefined;
    this.valueHost.replaceChildren(
      this.colorMode === "hex" ? this.buildHexField() : this.buildComponentFields(),
    );
  }

  private buildHexField(): HTMLInputElement {
    const hexInput = createElement("input", {
      className: "color-picker__hex param__input",
      type: "text",
      on: {
        pointerdown: (event) => event.stopPropagation(),
        change: () => this.applyHex(),
        keydown: (event) => {
          if (event.key === "Enter") {
            this.applyHex();
          }
        },
      },
    });
    hexInput.spellcheck = false;
    this.hexInput = hexInput;
    return hexInput;
  }

  /** Three (or four, with alpha) unlabeled compact number fields: RGB channels 0..255, or HSL's
   *  hue in degrees and saturation/lightness/alpha as percentages - the same "row of raw numbers
   *  ordered by the mode toggle above them" convention `.param__vector` already uses for a plain
   *  vec3/vec4 field, so no per-channel text label is needed here either. */
  private buildComponentFields(): HTMLElement {
    const container = createElement("div", { className: "color-picker__components" });
    const channelCount = this.showAlpha ? 4 : 3;
    const max = this.colorMode === "rgb" ? [255, 255, 255, 255] : [360, 100, 100, 100];
    for (let index = 0; index < channelCount; index += 1) {
      const control = new NumberControl({
        value: this.componentValue(index),
        min: 0,
        max: max[index],
        step: 1,
        precision: 0,
        compact: true,
        onChange: (next): void => this.applyComponent(index, next, true),
        live: (next): void => this.applyComponent(index, next, false),
      });
      this.componentControls.push(control);
      container.append(control.element);
    }
    return container;
  }

  /** The current value of RGB/HSL channel `index` (R/G/B/A, or H/S/L/A), in the display units
   *  `buildComponentFields` bounds each field to. */
  private componentValue(index: number): number {
    const [r, g, b] = this.srgb();
    if (this.colorMode === "rgb") {
      const channels = [r, g, b, this.alpha];
      return Math.round((channels[index] ?? 0) * 255);
    }
    const [h, s, l] = rgbToHsl(r, g, b);
    const channels = [h, s * 100, l * 100, this.alpha * 100];
    return Math.round(channels[index] ?? 0);
  }

  /** Applies an edited RGB/HSL channel back into the working HSV state (via `rgbToHsv`, the same
   *  boundary every other input path already converts through). */
  private applyComponent(index: number, next: number, final: boolean): void {
    const [r, g, b] = this.srgb();
    let nextRgb: readonly [number, number, number];
    if (this.colorMode === "rgb") {
      const channels = [r, g, b];
      if (index < 3) {
        channels[index] = clamp01(next / 255);
      } else if (this.showAlpha) {
        this.alpha = clamp01(next / 255);
      }
      nextRgb = [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0];
    } else {
      const [h, s, l] = rgbToHsl(r, g, b);
      const channels = [h, s, l];
      if (index === 0) {
        channels[0] = ((next % 360) + 360) % 360;
      } else if (index < 3) {
        channels[index] = clamp01(next / 100);
      } else if (this.showAlpha) {
        this.alpha = clamp01(next / 100);
      }
      nextRgb = hslToRgb(channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0);
    }
    const [hue, saturation, v] = rgbToHsv(nextRgb[0], nextRgb[1], nextRgb[2]);
    this.hue = hue;
    this.saturation = saturation;
    this.v = v;
    this.renderPopover();
    this.commit(final);
  }

  /** Repaints every popover part from the working HSV/alpha state. */
  private renderPopover(): void {
    if (this.popoverHandle === undefined) {
      return;
    }
    const [r, g, b] = this.srgb();
    const hue = hsvToRgb(this.hue, 1, 1);
    if (this.saturationValueArea !== undefined) {
      this.saturationValueArea.style.background = cssRgba(hue);
    }
    if (this.saturationValueCursor !== undefined) {
      this.saturationValueCursor.style.left = `${this.saturation * 100}%`;
      this.saturationValueCursor.style.top = `${(1 - this.v) * 100}%`;
      this.saturationValueCursor.style.background = cssRgba([r, g, b]);
    }
    if (this.hueThumb !== undefined) {
      this.hueThumb.style.left = `${(this.hue / 360) * 100}%`;
    }
    if (this.alphaThumb !== undefined) {
      this.alphaThumb.style.left = `${this.alpha * 100}%`;
    }
    if (this.alphaFill !== undefined) {
      this.alphaFill.style.background = `linear-gradient(to right, ${cssRgba([r, g, b], 0)}, ${cssRgba([r, g, b], 1)})`;
    }
    if (this.preview !== undefined) {
      // backgroundColor only, so the checker (color.css) stays underneath instead of being wiped
      // by the `background` shorthand.
      this.preview.style.backgroundColor = cssRgba([r, g, b], this.alpha);
    }
    if (this.hexInput !== undefined && document.activeElement !== this.hexInput) {
      this.hexInput.value = rgbToHex([r, g, b], this.showAlpha ? this.alpha : undefined);
    }
    this.componentControls.forEach((control, index) =>
      control.setValue(this.componentValue(index)),
    );
    this.renderPaletteSwatches();
  }

  private applyHex(): void {
    if (this.hexInput === undefined) {
      return;
    }
    const parsed = parseHex(this.hexInput.value);
    if (parsed === undefined) {
      this.renderPopover(); // revert the field to the current color
      return;
    }
    const [hue, saturation, v] = rgbToHsv(parsed[0], parsed[1], parsed[2]);
    this.hue = hue;
    this.saturation = saturation;
    this.v = v;
    if (this.showAlpha) {
      this.alpha = parsed[3];
    }
    this.renderPopover();
    // A single-shot edit (no drag involved) - one commit, matching a NumberControl text-edit commit.
    this.commit(true);
  }

  /** Rebuilds the palette column's row list: one row per saved swatch (preview, label, remove
   *  button; clicking the row body applies it) - the save button beside the list is static and
   *  untouched here. No-op without a wired {@link PaletteAccess}. */
  private renderPaletteSwatches(): void {
    const palette = this.config.palette;
    if (this.paletteList === undefined || palette === undefined) {
      return;
    }
    const rows = palette.swatches().map((swatch) => {
      const [r, g, b, a] = linearToSrgbRgba(swatch.color);
      const swatchDot = createElement("span", { className: "color-picker__palette-swatch" });
      swatchDot.style.backgroundColor = cssRgba([r, g, b], a);
      const label = createElement("span", {
        className: "color-picker__palette-label",
        textContent: swatch.label,
      });
      // Guarded like every other library-row delete (countdownConfirm.ts).
      const removeButton = createElement("button", {
        className: "color-picker__palette-remove confirm-danger",
        type: "button",
        on: { pointerdown: (event) => event.stopPropagation() },
      });
      removeButton.innerHTML = actionIcons.trash;
      attachTooltip(removeButton, t("colorPicker.removeSwatch"), t("colorPicker.removeSwatchTip"));
      attachCountdownConfirm(removeButton, actionIcons.trash, PALETTE_REMOVE_CLICKS, () => {
        palette.onRemove(swatch.name);
        this.renderPaletteSwatches();
      });
      // A div, not a button - a button can't nest `removeButton`; the row still applies the
      // swatch on click, `removeButton`'s own stopPropagation keeps that click from double-firing.
      return createElement(
        "div",
        {
          className: "color-picker__palette-row",
          on: {
            pointerdown: (event) => event.stopPropagation(),
            click: (event) => {
              event.stopPropagation();
              this.setFromLinear(swatch.color);
              this.renderPopover();
              this.commit(true);
            },
          },
        },
        [swatchDot, label, removeButton],
      );
    });
    this.paletteList.replaceChildren(...rows);
  }

  /**
   * Wires a pointer drag on `track`, reporting the pointer's clamped `x`/`y` fraction (`0..1`)
   * across the element through `onMove` on the initial press and every move (live), then once
   * more through the final committing call - mirroring NumberControl's scrub gesture.
   */
  private dragTarget(track: HTMLElement, onMove: (x: number, y: number) => void): void {
    const apply = (event: PointerEvent, final: boolean): void => {
      const rectangle = track.getBoundingClientRect();
      const x = rectangle.width === 0 ? 0 : (event.clientX - rectangle.left) / rectangle.width;
      const y = rectangle.height === 0 ? 0 : (event.clientY - rectangle.top) / rectangle.height;
      onMove(clamp01(x), clamp01(y));
      this.commit(final);
    };
    track.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      event.preventDefault();
      apply(event, false);
      this.activeDrag = beginPointerDrag(track, event, {
        onMove: (moveEvent) => apply(moveEvent, false),
        onEnd: () => {
          this.activeDrag = undefined;
          // One commit for the whole gesture, at wherever the pointer ended up (already applied by
          // the last live step above, or by the initial press if the pointer never moved at all).
          this.commit(true);
        },
      });
    });
  }
}
