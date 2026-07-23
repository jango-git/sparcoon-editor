/**
 * A color-picker control: a flat swatch button that opens a floating popover with a saturation/value
 * square, a hue slider, an alpha slider and a hex field (flat, sharp-cornered, accent on
 * interaction). The popover is screen-space (`position: fixed` at the swatch rectangle, appended to
 * `<body>` via the shared popover), so the graph canvas's pan/zoom never displaces it, mirroring
 * {@link Dropdown}.
 *
 * Presentational and speaks the engine's color model: it takes and emits linear RGBA
 * (`[r, g, b, a]`, each `0..1`). Internally it holds sRGB HSV + alpha (what the hue wheel / hex
 * read), converting at the boundary. `setValue` re-syncs from external state (undo / redo) without
 * firing. `onChange` fires exactly once per gesture - a slider drag's release, or a single-shot hex
 * edit - never per intermediate drag step; the optional `live` fires on every intermediate slider
 * step instead (omit it for no live preview at all during a drag).
 */

import { createElement } from "../dom";
import type { ValueComponent } from "../primitives/component";
import { beginPointerDrag } from "../primitives/drag";
import { clamp01 } from "../primitives/math";
import { openPopover, type PopoverHandle } from "../primitives/popover";
import {
  cssRgba,
  hsvToRgb,
  linearToSrgbRgba,
  parseHex,
  rgbToHex,
  rgbToHsv,
  srgbToLinearRgba,
  type Rgba,
} from "./color";

export interface ColorPickerConfig {
  /** Initial color as linear RGBA (each `0..1`). */
  readonly value: Rgba;
  /** Whether to expose the alpha channel (default true); when false, alpha is pinned to 1. */
  readonly alpha?: boolean;
  /** Fires once, with the final linear RGBA, at the end of a gesture (see the class doc). */
  readonly onChange: (value: Rgba) => void;
  /** Fires with the linear RGBA on every intermediate slider step (see the class doc). */
  readonly live?: ((value: Rgba) => void) | undefined;
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

  // Popover parts, live only while open.
  private saturationValueCursor: HTMLElement | undefined;
  private saturationValueArea: HTMLElement | undefined;
  private hueThumb: HTMLElement | undefined;
  private alphaThumb: HTMLElement | undefined;
  private alphaFill: HTMLElement | undefined;
  private preview: HTMLElement | undefined;
  private hexInput: HTMLInputElement | undefined;

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

    // Preview swatch + hex field.
    this.preview = createElement("div", { className: "color-picker__preview" });
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
    const row = createElement("div", { className: "color-picker__row" }, [this.preview, hexInput]);

    popover.append(
      this.saturationValueArea,
      createElement("div", { className: "color-picker__sliders" }, sliders),
      row,
    );

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
            undefined;
        this.hexInput = undefined;
        this.element.classList.remove("color-swatch--open");
      },
    });
    this.renderPopover();
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
