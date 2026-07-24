/**
 * Color-space helpers shared by the color-picker and color-ramp controls.
 *
 * The engine stores colors as linear RGBA (each channel `0..1`) - that is what a node's `color`
 * value and a gradient stop carry, and what a linear material expects. Authoring, though, happens
 * in sRGB: a hex string, a hue wheel and a swatch all read in gamma space. So these controls hold
 * their working state in sRGB and convert at the boundary: `linearToSrgb` / `srgbToLinear` per RGB
 * channel (alpha is not gamma-encoded and passes through untouched), plus the usual HSV/HSL <-> RGB
 * and hex <-> RGB conversions.
 *
 * All tuples are `[r, g, b]` / `[r, g, b, a]` with channels in `0..1` unless noted.
 */

import { clamp01 } from "../primitives/math";

export type Rgb = readonly [number, number, number];
export type Rgba = readonly [number, number, number, number];

/** One sRGB channel (0..1) to linear (0..1). */
export function srgbToLinear(channel: number): number {
  const x = clamp01(channel);
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

/** One linear channel (0..1) to sRGB (0..1). */
export function linearToSrgb(channel: number): number {
  const x = clamp01(channel);
  return x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
}

/** Linear RGBA -> sRGB RGBA (alpha unchanged). */
export function linearToSrgbRgba(rgba: Rgba): Rgba {
  return [linearToSrgb(rgba[0]), linearToSrgb(rgba[1]), linearToSrgb(rgba[2]), clamp01(rgba[3])];
}

/** sRGB RGBA -> linear RGBA (alpha unchanged). */
export function srgbToLinearRgba(rgba: Rgba): Rgba {
  return [srgbToLinear(rgba[0]), srgbToLinear(rgba[1]), srgbToLinear(rgba[2]), clamp01(rgba[3])];
}

/** HSV (`hue` in 0..360, `saturation`/`v` in 0..1) -> sRGB `[r, g, b]` in 0..1. */
export function hsvToRgb(hue: number, saturation: number, v: number): Rgb {
  const hueSector = (((hue % 360) + 360) % 360) / 60;
  const chroma = v * saturation;
  const x = chroma * (1 - Math.abs((hueSector % 2) - 1));
  const matchOffset = v - chroma;
  const [r, g, b] =
    hueSector < 1
      ? [chroma, x, 0]
      : hueSector < 2
        ? [x, chroma, 0]
        : hueSector < 3
          ? [0, chroma, x]
          : hueSector < 4
            ? [0, x, chroma]
            : hueSector < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  return [r + matchOffset, g + matchOffset, b + matchOffset];
}

/** sRGB `[r, g, b]` (0..1) -> HSV `[h (0..360), s (0..1), v (0..1)]`. */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta !== 0) {
    if (max === r) {
      hue = ((g - b) / delta) % 6;
    } else if (max === g) {
      hue = (b - r) / delta + 2;
    } else {
      hue = (r - g) / delta + 4;
    }
    hue *= 60;
    if (hue < 0) {
      hue += 360;
    }
  }
  const saturation = max === 0 ? 0 : delta / max;
  return [hue, saturation, max];
}

/** sRGB `[r, g, b]` (0..1) -> HSL `[h (0..360), s (0..1), l (0..1)]`. */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (delta !== 0) {
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    if (max === r) {
      h = ((g - b) / delta) % 6;
    } else if (max === g) {
      h = (b - r) / delta + 2;
    } else {
      h = (r - g) / delta + 4;
    }
    h *= 60;
    if (h < 0) {
      h += 360;
    }
  }
  return [h, s, l];
}

/** HSL (`h` in 0..360, `s`/`l` in 0..1) -> sRGB `[r, g, b]` in 0..1. */
export function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s === 0) {
    return [l, l, l];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hueToChannel = (t: number): number => {
    // Only the out-of-range ends need folding into [0, 1) - an unconditional modulo round-trip
    // would reintroduce float error at an already-exact boundary (e.g. t === 2/3).
    const wrapped = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (wrapped < 1 / 6) {
      return p + (q - p) * 6 * wrapped;
    }
    if (wrapped < 1 / 2) {
      return q;
    }
    if (wrapped < 2 / 3) {
      return p + (q - p) * (2 / 3 - wrapped) * 6;
    }
    return p;
  };
  const hueFraction = h / 360;
  return [
    hueToChannel(hueFraction + 1 / 3),
    hueToChannel(hueFraction),
    hueToChannel(hueFraction - 1 / 3),
  ];
}

const hex2 = (channel: number): string =>
  Math.round(clamp01(channel) * 255)
    .toString(16)
    .padStart(2, "0");

/** sRGB `[r, g, b]` (0..1) -> `#rrggbb`; with an alpha arg -> `#rrggbbaa`. */
export function rgbToHex(rgb: Rgb, alpha?: number): string {
  const base = `#${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}`;
  return alpha === undefined ? base : `${base}${hex2(alpha)}`;
}

/**
 * Parses `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` (with or without `#`) into sRGB
 * `[r, g, b, a]` in 0..1. Returns `undefined` on any malformed input, so a caller can
 * ignore a half-typed hex without disturbing the current color.
 */
export function parseHex(input: string): Rgba | undefined {
  const hex = input.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    return undefined;
  }
  const expand = (hexSegment: string): number =>
    parseInt(hexSegment.length === 1 ? hexSegment + hexSegment : hexSegment, 16) / 255;
  if (hex.length === 3 || hex.length === 4) {
    const alpha = hex.length === 4 ? expand(hex.charAt(3)) : 1;
    return [expand(hex.charAt(0)), expand(hex.charAt(1)), expand(hex.charAt(2)), alpha];
  }
  if (hex.length === 6 || hex.length === 8) {
    const alpha = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return [
      parseInt(hex.slice(0, 2), 16) / 255,
      parseInt(hex.slice(2, 4), 16) / 255,
      parseInt(hex.slice(4, 6), 16) / 255,
      alpha,
    ];
  }
  return undefined;
}

/** A CSS `rgb()/rgba()` string from an sRGB `[r,g,b]` (0..1) and optional alpha, for previews. */
export function cssRgba(rgb: Rgb, alpha = 1): string {
  const to255 = (channel: number): number => Math.round(clamp01(channel) * 255);
  return `rgba(${to255(rgb[0])}, ${to255(rgb[1])}, ${to255(rgb[2])}, ${clamp01(alpha)})`;
}
