/**
 * Preview view settings - how the studio surroundings are drawn (lights, fill colors, reference
 * gizmos, background). UI settings separate from the document, persisted on their own localStorage
 * key (see {@link PersistedStore}). Colors are stored as linear RGBA (`0..1` per channel), the way
 * the rest of the editor speaks color, so {@link ColorPicker} and the render layer need no
 * conversion at this boundary.
 */

import { parseHex, srgbToLinearRgba, type Rgba } from "../ui/components/color";
import { asBoolean, asFiniteNumber, asOptionalString, isRecord } from "../util/guards";
import { PersistedStore } from "./persistedStore";

export interface PreviewSettings {
  /** The shadow-casting key light. */
  readonly sun: boolean;
  /** Sun (key light) color, linear RGBA. */
  readonly sunColor: Rgba;
  /** Sun (key light) intensity. */
  readonly sunIntensity: number;
  /** Sun compass direction in degrees (0..360, measured around the up axis). */
  readonly sunAzimuth: number;
  /** Sun height above the horizon in degrees (0 = horizon, 90 = straight overhead). */
  readonly sunElevation: number;
  /** The sky/ground hemisphere fill light. */
  readonly hemisphere: boolean;
  /** Hemisphere sky color ("first" color), linear RGBA. */
  readonly hemisphereSky: Rgba;
  /** Hemisphere ground color ("second" color), linear RGBA. */
  readonly hemisphereGround: Rgba;
  /** Hemisphere fill intensity. */
  readonly hemisphereIntensity: number;
  /** A grid drawn on the ground plane. */
  readonly grid: boolean;
  /** A wireframe player-figure box (2 x 0.5 x 0.75) as a scale reference. */
  readonly playerFigure: boolean;
  /** The scene background color, linear RGBA. Ignored while {@link activeEnvironmentName} is set. */
  readonly background: Rgba;
  /** The active environment asset's `name` (ADR-0004), or `undefined` for manual Sun + Hemisphere
   *  lighting. View-only - never enters the document, so it is not exported. */
  readonly activeEnvironmentName: string | undefined;
}

const STORAGE_KEY = "sparcoon-editor.preview";

/** Linear RGBA from an sRGB hex literal (falls back to opaque black on a typo). */
function linearFromHex(hex: string): Rgba {
  const parsed = parseHex(hex);
  return parsed === undefined ? [0, 0, 0, 1] : srgbToLinearRgba(parsed);
}

/** Defaults mirror the studio colors the environment shipped with. */
export const DEFAULT_PREVIEW_SETTINGS: PreviewSettings = {
  sun: true,
  sunColor: linearFromHex("ffffff"),
  sunIntensity: 2.2,
  sunAzimuth: 45,
  sunElevation: 50,
  hemisphere: true,
  hemisphereSky: linearFromHex("bcc7d6"),
  hemisphereGround: linearFromHex("2b2620"),
  hemisphereIntensity: 0.7,
  grid: true,
  playerFigure: true,
  background: linearFromHex("2b2e33"),
  activeEnvironmentName: undefined,
};

/**
 * A single instance is created at the composition root and shared by the settings overlay (which
 * writes it) and the render layer (which subscribes to it).
 */
export class PreviewSettingsStore extends PersistedStore<PreviewSettings> {
  constructor() {
    super(STORAGE_KEY, DEFAULT_PREVIEW_SETTINGS, parsePreviewSettings);
  }
}

function parsePreviewSettings(raw: unknown): PreviewSettings {
  if (!isRecord(raw)) {
    return DEFAULT_PREVIEW_SETTINGS;
  }
  return {
    sun: asBoolean(raw["sun"], DEFAULT_PREVIEW_SETTINGS.sun),
    sunColor: asRgba(raw["sunColor"], DEFAULT_PREVIEW_SETTINGS.sunColor),
    sunIntensity: asFiniteNumber(raw["sunIntensity"], DEFAULT_PREVIEW_SETTINGS.sunIntensity),
    sunAzimuth: asFiniteNumber(raw["sunAzimuth"], DEFAULT_PREVIEW_SETTINGS.sunAzimuth),
    sunElevation: asFiniteNumber(raw["sunElevation"], DEFAULT_PREVIEW_SETTINGS.sunElevation),
    hemisphere: asBoolean(raw["hemisphere"], DEFAULT_PREVIEW_SETTINGS.hemisphere),
    hemisphereSky: asRgba(raw["hemisphereSky"], DEFAULT_PREVIEW_SETTINGS.hemisphereSky),
    hemisphereGround: asRgba(raw["hemisphereGround"], DEFAULT_PREVIEW_SETTINGS.hemisphereGround),
    hemisphereIntensity: asFiniteNumber(
      raw["hemisphereIntensity"],
      DEFAULT_PREVIEW_SETTINGS.hemisphereIntensity,
    ),
    grid: asBoolean(raw["grid"], DEFAULT_PREVIEW_SETTINGS.grid),
    playerFigure: asBoolean(raw["playerFigure"], DEFAULT_PREVIEW_SETTINGS.playerFigure),
    background: asRgba(raw["background"], DEFAULT_PREVIEW_SETTINGS.background),
    activeEnvironmentName: asOptionalString(raw["activeEnvironmentName"]),
  };
}

function asRgba(value: unknown, fallback: Rgba): Rgba {
  if (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((channel) => typeof channel === "number" && Number.isFinite(channel))
  ) {
    return [value[0], value[1], value[2], value[3]] as Rgba;
  }
  return fallback;
}
