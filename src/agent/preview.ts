/**
 * The viewport for the agent: transport controls, framing, and image captures. A capture at a
 * given time replays the timeline from 0 in fixed steps inside one task, so the live frame loop
 * cannot interleave: the timeline dispatcher fires the spawn events and drives the values exactly
 * as it does during playback, and the coordinator steps the simulation by the fixed step instead
 * of wall-clock time. Spawn randomness is not seeded, so two captures of the same moment match in
 * composition and timing but not pixel for pixel.
 */

import { Color, Vector3, type Object3D } from "three";
import type { SourceState } from "../model/editorState";
import type { SceneEntity } from "../model/entity";
import { VFX_ENTITY } from "../model/entity";
import type { Store } from "../model/store";
import type { TransportStore } from "../model/transport";
import type {
  CaptureView,
  FrameCaptureOptions,
  SceneCoordinator,
} from "../render/sceneCoordinator";
import {
  requireFiniteNumber,
  requireInteger,
  requireKnownKeys,
  requireVector3,
} from "./arguments.Internal";
import { resolveEntity } from "./address.Internal";
import { AgentError } from "./errors";
import { settle } from "./settle.Internal";

/** How each captured frame is drawn - shared by single captures and sequences. */
export interface FrameOptions {
  /** Image (or cell) size in pixels; omitted, the viewport's own size. Both or neither. */
  readonly width?: number;
  readonly height?: number;
  /** Draws the effect alone: no ground, grid, player figure or gizmos. */
  readonly clean?: boolean;
  /**
   * `"#rrggbb"` (sRGB, as a game would state it) or `"transparent"`; omitted, the viewport's own
   * background. Transparent loses purely additive light (see `SceneCoordinator.capture`), so a
   * solid color is the one to compare against a game frame with.
   */
  readonly background?: string;
  /**
   * A capture-only camera, in world units: placed at `position`, looking at `target`, with an
   * optional vertical `fov` in degrees. The viewport camera is left where it is.
   */
  readonly camera?: {
    readonly position: readonly number[];
    readonly target: readonly number[];
    readonly fov?: number;
  };
  /**
   * Fits a sphere of `radius` around an entity (default: the VFX group) into the frame, seen from
   * the viewport camera's current side, at any distance - small objects included. In a sequence
   * it follows the entity at each captured time. Not combinable with `camera`.
   */
  readonly frame?: { readonly entity?: string; readonly radius: number };
}

export interface CaptureOptions extends FrameOptions {
  /** Timeline time (seconds) to replay to before capturing; omitted, captures the current frame. */
  readonly time?: number;
}

export interface SequenceOptions extends FrameOptions {
  /** Timeline times (seconds) to capture, one cell each, laid out in ascending order. */
  readonly times: readonly number[];
  /** Grid columns; defaults to a near-square grid. */
  readonly columns?: number;
}

export interface PreviewApi {
  play(): void;
  pause(): void;
  /** Stops and rewinds to 0, clearing live particles. */
  stop(): void;
  /** Frames an entity in the viewport (default: the whole VFX group). */
  focus(entityId?: string): void;
  /** A PNG data URL of the viewport. After a timed capture the transport is left paused there. */
  capture(options?: CaptureOptions): Promise<string>;
  /** One PNG data URL laying out a capture per time in a labelled grid. */
  captureSequence(options: SequenceOptions): Promise<string>;
}

export interface PreviewDependencies {
  readonly store: Store;
  readonly transport: TransportStore;
  readonly coordinator: Pick<SceneCoordinator, "advance" | "capture">;
  readonly focusEntity: (entity: SceneEntity) => void;
  /** The live viewport object of an entity, for framing a capture on it. */
  readonly entityObject: (entity: SceneEntity) => Object3D | undefined;
}

/** The fixed simulation step a timed capture replays with (the live loop's nominal rate). */
const SIMULATION_STEP = 1 / 60;
/** The largest capture edge accepted, in pixels. A weak GPU may still clamp the drawing buffer
 *  below it; the capture then comes back at the size actually rendered. */
const MAX_CAPTURE_SIZE = 4096;
/** Below this, a remaining interval is float noise rather than time left to simulate. */
const TIME_EPSILON = 1e-9;

const FRAME_OPTION_KEYS = ["width", "height", "clean", "background", "camera", "frame"] as const;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** The capture-only point of view `options` asks for, checked; `undefined` for the viewport's. */
function requireView(
  options: FrameOptions,
  source: SourceState,
  entityObject: (entity: SceneEntity) => Object3D | undefined,
): CaptureView | undefined {
  const { camera, frame } = options;
  if (camera !== undefined && frame !== undefined) {
    throw new AgentError("invalid_argument", "Pass camera or frame, not both.");
  }
  if (camera !== undefined) {
    requireKnownKeys("camera", camera, ["position", "target", "fov"]);
    return {
      kind: "look",
      position: new Vector3(...requireVector3("camera.position", camera.position)),
      target: new Vector3(...requireVector3("camera.target", camera.target)),
      ...(camera.fov !== undefined ? { fov: requireFov(camera.fov) } : {}),
    };
  }
  if (frame !== undefined) {
    requireKnownKeys("frame", frame, ["entity", "radius"]);
    const radius = requireFiniteNumber("frame.radius", frame.radius);
    if (radius <= 0) {
      throw new AgentError("invalid_argument", "frame.radius must be positive.");
    }
    const entity = frame.entity === undefined ? VFX_ENTITY : resolveEntity(source, frame.entity);
    const object = entityObject(entity);
    if (object === undefined) {
      throw new AgentError("rejected", "That entity has nothing in the viewport to frame.");
    }
    return { kind: "frame", object, radius };
  }
  return undefined;
}

function requireFov(value: unknown): number {
  const fov = requireFiniteNumber("camera.fov", value);
  if (fov <= 0 || fov >= 180) {
    throw new AgentError("invalid_argument", "camera.fov must be within (0, 180) degrees.");
  }
  return fov;
}

/** The coordinator's view of a frame's options, checked; `view` already resolved. */
function requireFrame(options: FrameOptions, view: CaptureView | undefined): FrameCaptureOptions {
  const { width, height, clean, background } = options;
  if (clean !== undefined && typeof clean !== "boolean") {
    throw new AgentError("invalid_argument", "clean must be a boolean.");
  }
  if (background !== undefined && background !== "transparent" && !HEX_COLOR.test(background)) {
    throw new AgentError("invalid_argument", 'background must be "#rrggbb" or "transparent".');
  }
  return {
    ...(width !== undefined || height !== undefined
      ? {
          size: {
            width: requireInteger("width", width, 1, MAX_CAPTURE_SIZE),
            height: requireInteger("height", height, 1, MAX_CAPTURE_SIZE),
          },
        }
      : {}),
    ...(clean === true ? { overlays: false } : {}),
    // three reads a hex string as sRGB and converts it to its linear working space.
    ...(background === undefined
      ? {}
      : { background: background === "transparent" ? "transparent" : new Color(background) }),
    ...(view !== undefined ? { view } : {}),
  };
}

/**
 * Lays `frames` out in a grid, each cell labelled with its time. A solid `background` fills the
 * sheet first, so the cells a short last row leaves empty match the frames instead of staying
 * transparent.
 */
function composeSheet(
  frames: readonly { readonly time: number; readonly image: HTMLCanvasElement }[],
  columns: number,
  background: string | undefined,
): HTMLCanvasElement {
  const cellWidth = Math.max(...frames.map((frame) => frame.image.width));
  const cellHeight = Math.max(...frames.map((frame) => frame.image.height));
  const sheet = document.createElement("canvas");
  sheet.width = cellWidth * columns;
  sheet.height = cellHeight * Math.ceil(frames.length / columns);
  const context = sheet.getContext("2d") ?? undefined;
  if (context === undefined) {
    throw new AgentError("rejected", "No 2D canvas context to compose the sheet.");
  }
  if (background !== undefined && background !== "transparent") {
    context.fillStyle = background;
    context.fillRect(0, 0, sheet.width, sheet.height);
  }
  const fontSize = Math.max(12, Math.round(cellHeight / 24));
  context.font = `${String(fontSize)}px monospace`;
  context.textBaseline = "top";
  frames.forEach((frame, index) => {
    const x = (index % columns) * cellWidth;
    const y = Math.floor(index / columns) * cellHeight;
    context.drawImage(frame.image, x, y);
    const label = `t=${frame.time.toFixed(2)}s`;
    const padding = Math.round(fontSize / 3);
    context.fillStyle = "rgba(0, 0, 0, 0.6)";
    context.fillRect(x, y, context.measureText(label).width + padding * 2, fontSize + padding * 2);
    context.fillStyle = "#ffffff";
    context.fillText(label, x + padding, y + padding);
  });
  return sheet;
}

export function createPreviewApi(dependencies: PreviewDependencies): PreviewApi {
  const { store, transport, coordinator, focusEntity, entityObject } = dependencies;

  const requireTime = (name: string, value: unknown): number => {
    const time = requireFiniteNumber(name, value);
    const duration = store.getSource().timeline.duration;
    if (time < 0 || time > duration) {
      throw new AgentError("invalid_argument", `${name} must be within [0, ${String(duration)}].`);
    }
    return time;
  };

  /** Replays the timeline from 0, capturing once at each of `times` (ascending). */
  const replay = async (
    times: readonly number[],
    frame: FrameCaptureOptions,
  ): Promise<{ readonly time: number; readonly image: HTMLCanvasElement }[]> => {
    // Let a pending recompute land first, so its restart-on-rebuild can't rewind mid-replay.
    await settle();
    // Stop rewinds and lets the dispatcher clear live particles; play arms event dispatch.
    transport.stop();
    transport.play();
    const frames: { readonly time: number; readonly image: HTMLCanvasElement }[] = [];
    try {
      let now = 0;
      for (const time of times) {
        while (time - now > TIME_EPSILON) {
          const next = Math.min(time, now + SIMULATION_STEP);
          transport.seek(next);
          coordinator.advance(next - now);
          now = next;
        }
        frames.push({ time, image: coordinator.capture(frame) });
      }
    } finally {
      // Never leave the live loop running a replay that failed part-way.
      transport.pause();
    }
    return frames;
  };

  return {
    play: () => transport.play(),
    pause: () => transport.pause(),
    stop: () => transport.stop(),

    focus: (entityId) =>
      focusEntity(entityId === undefined ? VFX_ENTITY : resolveEntity(store.getSource(), entityId)),

    capture: async (options = {}): Promise<string> => {
      requireKnownKeys("options", options, ["time", ...FRAME_OPTION_KEYS]);
      const frame = requireFrame(options, requireView(options, store.getSource(), entityObject));
      if (options.time === undefined) {
        await settle();
        return coordinator.capture(frame).toDataURL("image/png");
      }
      const [captured] = await replay([requireTime("time", options.time)], frame);
      if (captured === undefined) {
        throw new AgentError("rejected", "Capture produced no frame.");
      }
      return captured.image.toDataURL("image/png");
    },

    captureSequence: async (options): Promise<string> => {
      requireKnownKeys("options", options, ["times", "columns", ...FRAME_OPTION_KEYS]);
      if (!Array.isArray(options.times) || options.times.length === 0) {
        throw new AgentError("invalid_argument", "times must be a non-empty array.");
      }
      const times = options.times
        .map((time, index) => requireTime(`times[${String(index)}]`, time))
        .sort((first, second) => first - second);
      const columns =
        options.columns === undefined
          ? Math.ceil(Math.sqrt(times.length))
          : requireInteger("columns", options.columns, 1, times.length);
      const frame = requireFrame(options, requireView(options, store.getSource(), entityObject));
      return composeSheet(await replay(times, frame), columns, options.background).toDataURL(
        "image/png",
      );
    },
  };
}
