/**
 * Transform-gizmo settings: axis space + per-mode snap increments. Editor preferences, not document
 * state - never entering undo/the saved source (see {@link PersistedStore}). Snap defaults off;
 * holding Ctrl temporarily inverts each mode's snap, Blender's "increment snap" toggle.
 */

import { isRecord } from "../util/guards";
import { PersistedStore } from "./persistedStore";

export type TransformSpace = "global" | "local";

export interface SnapSetting {
  readonly enabled: boolean;
  /** Increment: world units (move), degrees (rotate), or scale factor (scale). */
  readonly step: number;
}

export interface GizmoSettings {
  /** Axis space for constrained transforms: world axes (`global`) or the object's own (`local`). */
  readonly space: TransformSpace;
  readonly move: SnapSetting;
  readonly rotate: SnapSetting;
  readonly scale: SnapSetting;
}

export const DEFAULT_GIZMO_SETTINGS: GizmoSettings = {
  space: "global",
  move: { enabled: false, step: 0.25 },
  rotate: { enabled: false, step: 15 },
  scale: { enabled: false, step: 0.1 },
};

const STORAGE_KEY = "sparcoon-editor.gizmo";

export class GizmoSettingsStore extends PersistedStore<GizmoSettings> {
  constructor() {
    super(STORAGE_KEY, DEFAULT_GIZMO_SETTINGS, parseGizmoSettings);
  }
}

function parseGizmoSettings(raw: unknown): GizmoSettings {
  if (!isRecord(raw)) {
    return DEFAULT_GIZMO_SETTINGS;
  }
  return {
    space: raw["space"] === "local" ? "local" : "global",
    move: snap(raw["move"], DEFAULT_GIZMO_SETTINGS.move),
    rotate: snap(raw["rotate"], DEFAULT_GIZMO_SETTINGS.rotate),
    scale: snap(raw["scale"], DEFAULT_GIZMO_SETTINGS.scale),
  };
}

function snap(value: unknown, fallback: SnapSetting): SnapSetting {
  if (!isRecord(value)) {
    return fallback;
  }
  const step = value["step"];
  return {
    enabled: typeof value["enabled"] === "boolean" ? value["enabled"] : fallback.enabled,
    step: typeof step === "number" && Number.isFinite(step) && step > 0 ? step : fallback.step,
  };
}
