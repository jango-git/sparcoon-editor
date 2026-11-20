/**
 * How the studio surroundings are drawn (lights, ground, gizmos, background). Colors are linear
 * RGBA, `0..1` per channel.
 */

import { parseHex, type Rgba, srgbToLinearRgba } from "../ui/components/color";
import { asBoolean, asFiniteNumber, isRecord } from "../util/guards";
import { PersistedStore } from "./persistedStore";

export interface PreviewSettings {
  /** The shadow-casting key light. */
  readonly sun: boolean;
  readonly sunColor: Rgba;
  readonly sunIntensity: number;
  /** Sun compass direction in degrees (0..360, measured around the up axis). */
  readonly sunAzimuth: number;
  /** Sun height above the horizon in degrees (0 = horizon, 90 = straight overhead). */
  readonly sunElevation: number;
  /** The sky/ground hemisphere fill light. */
  readonly hemisphere: boolean;
  readonly hemisphereSky: Rgba;
  readonly hemisphereGround: Rgba;
  readonly hemisphereIntensity: number;
  /** The studio ground: what shadows fall on and a Depth Fade fades against. */
  readonly ground: boolean;
  readonly grid: boolean;
  /** A wireframe player-figure box (2 x 0.5 x 0.75) as a scale reference. */
  readonly playerFigure: boolean;
  /** The object outlines (group, emitters, meshes) and the sun's direction marker. */
  readonly gizmos: boolean;
  /** The scene background color, linear RGBA. Ignored while an environment is active
   *  (`SourceState.activeEnvironmentName`). */
  readonly background: Rgba;
}

const STORAGE_KEY = "sparcoon-editor.preview";

/** Linear RGBA from an sRGB hex literal (falls back to opaque black on a typo). */
function linearFromHex(hex: string): Rgba {
  const parsed = parseHex(hex);
  return parsed === undefined ? [0, 0, 0, 1] : srgbToLinearRgba(parsed);
}

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
  ground: true,
  grid: true,
  playerFigure: true,
  gizmos: true,
  background: linearFromHex("2b2e33"),
};

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
    ground: asBoolean(raw["ground"], DEFAULT_PREVIEW_SETTINGS.ground),
    grid: asBoolean(raw["grid"], DEFAULT_PREVIEW_SETTINGS.grid),
    playerFigure: asBoolean(raw["playerFigure"], DEFAULT_PREVIEW_SETTINGS.playerFigure),
    gizmos: asBoolean(raw["gizmos"], DEFAULT_PREVIEW_SETTINGS.gizmos),
    background: asRgba(raw["background"], DEFAULT_PREVIEW_SETTINGS.background),
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
