/**
 * The viewport for the agent: transport controls, framing, and image captures. A capture at a
 * given time replays the timeline from 0 in fixed steps inside one task, so the live frame loop
 * cannot interleave: the timeline dispatcher fires the spawn events and drives the values exactly
 * as it does during playback, and the coordinator steps the simulation by the fixed step instead
 * of wall-clock time. Spawn randomness is not seeded, so two captures of the same moment match in
 * composition and timing but not pixel for pixel.
 */

import type { SceneEntity } from "../model/entity";
import { VFX_ENTITY } from "../model/entity";
import type { Store } from "../model/store";
import type { TransportStore } from "../model/transport";
import type { SceneCoordinator } from "../render/sceneCoordinator";
import { requireFiniteNumber, requireInteger, requireKnownKeys } from "./arguments.Internal";
import { resolveEntity } from "./address.Internal";
import { AgentError } from "./errors";
import { settle } from "./settle.Internal";

export interface CaptureOptions {
  /** Timeline time (seconds) to replay to before capturing; omitted, captures the current frame. */
  readonly time?: number;
  /** Image size in pixels; omitted, the viewport's own size. Both or neither. */
  readonly width?: number;
  readonly height?: number;
}

export interface SequenceOptions {
  /** Timeline times (seconds) to capture, one cell each, laid out in ascending order. */
  readonly times: readonly number[];
  /** Grid columns; defaults to a near-square grid. */
  readonly columns?: number;
  /** Size of each cell in pixels; omitted, the viewport's own size. Both or neither. */
  readonly width?: number;
  readonly height?: number;
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
}

/** The fixed simulation step a timed capture replays with (the live loop's nominal rate). */
const SIMULATION_STEP = 1 / 60;
/** The largest capture edge accepted, in pixels. A weak GPU may still clamp the drawing buffer
 *  below it; the capture then comes back at the size actually rendered. */
const MAX_CAPTURE_SIZE = 4096;
/** Below this, a remaining interval is float noise rather than time left to simulate. */
const TIME_EPSILON = 1e-9;

type CaptureSize = { readonly width: number; readonly height: number } | undefined;

function requireSize(width: unknown, height: unknown): CaptureSize {
  if (width === undefined && height === undefined) {
    return undefined;
  }
  return {
    width: requireInteger("width", width, 1, MAX_CAPTURE_SIZE),
    height: requireInteger("height", height, 1, MAX_CAPTURE_SIZE),
  };
}

/** Lays `frames` out in a grid, each cell labelled with its time. */
function composeSheet(
  frames: readonly { readonly time: number; readonly image: HTMLCanvasElement }[],
  columns: number,
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
  const { store, transport, coordinator, focusEntity } = dependencies;

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
    size: CaptureSize,
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
        frames.push({ time, image: coordinator.capture(size) });
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
      requireKnownKeys("options", options, ["time", "width", "height"]);
      const size = requireSize(options.width, options.height);
      if (options.time === undefined) {
        await settle();
        return coordinator.capture(size).toDataURL("image/png");
      }
      const [frame] = await replay([requireTime("time", options.time)], size);
      if (frame === undefined) {
        throw new AgentError("rejected", "Capture produced no frame.");
      }
      return frame.image.toDataURL("image/png");
    },

    captureSequence: async (options): Promise<string> => {
      requireKnownKeys("options", options, ["times", "columns", "width", "height"]);
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
      const size = requireSize(options.width, options.height);
      return composeSheet(await replay(times, size), columns).toDataURL("image/png");
    },
  };
}
