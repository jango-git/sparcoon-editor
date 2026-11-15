/**
 * The viewport for the agent: transport controls, framing, image captures and overdraw counts. A
 * capture or count at a given time replays the timeline from 0 in fixed steps inside one task, so the live frame loop
 * cannot interleave: the timeline dispatcher fires the spawn events and drives the values exactly
 * as it does during playback, and the coordinator steps the simulation by the fixed step instead
 * of wall-clock time. Spawn randomness is not seeded, so two captures of the same moment match in
 * composition and timing but not pixel for pixel.
 */

import { Color, type Object3D, Vector3 } from "three";

import type { SourceState } from "../model/editorState";
import type { SceneEntity } from "../model/entity";
import { VFX_ENTITY } from "../model/entity";
import type { Store } from "../model/store";
import type { TransportStore } from "../model/transport";
import type { OverdrawStats } from "../render/overdrawPass";
import type { OverdrawCount } from "../render/overdrawShader";
import type {
  CaptureShot,
  CaptureView,
  FrameCaptureOptions,
  SceneCoordinator,
} from "../render/sceneCoordinator";
import { resolveEntity } from "./address.Internal";
import {
  requireFiniteNumber,
  requireInteger,
  requireKnownKeys,
  requireVector3,
} from "./arguments.Internal";
import { AgentError } from "./errors";
import { settle } from "./settle.Internal";

/** Where a frame is shot from and at what size - shared by captures and overdraw counts. */
export interface ShotOptions {
  /** Image (or cell) size in pixels; omitted, the viewport's own size. Both or neither. */
  readonly width?: number;
  readonly height?: number;
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

/** How each captured frame is drawn - shared by single captures and sequences. */
export interface FrameOptions extends ShotOptions {
  /** Draws the effect alone: no ground, grid, player figure or gizmos. */
  readonly clean?: boolean;
  /**
   * With `clean`, keeps the studio ground: the surface the effect's shadows fall on, its Depth
   * Fade fades against and its Depth Sample collides with, so an effect built around the ground
   * (debris settling, a crack in it) reads on it. Without `clean` the frame shows what the viewport shows.
   */
  readonly ground?: boolean;
  /**
   * `"#rrggbb"` (sRGB, as a game would state it) or `"transparent"`; omitted, the viewport's own
   * background. Transparent loses purely additive light (see `SceneCoordinator.capture`), so a
   * solid color is the one to compare against a game frame with.
   */
  readonly background?: string;
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

export interface OverdrawOptions extends ShotOptions {
  /** Timeline time (seconds) to replay to before counting; omitted, counts the current frame. */
  readonly time?: number;
  /**
   * `"rasterized"`: every fragment of the effect's quads and meshes, transparent texels and
   * discarded fragments included - the fill cost (the viewport's Overdraw). `"surviving"`: only the
   * fragments left after the alpha cutoff and alpha hash (the viewport's Discard).
   */
  readonly count: OverdrawCount;
}

/**
 * Layer counts over a frame. A pixel holds at most 255 layers, so `max` stops there and a
 * total over such pixels reads low.
 */
export interface OverdrawLayers {
  /** Fragments drawn over the frame: the sum of every pixel's layers. */
  readonly fragments: number;
  /** Fragments per pixel of the whole frame, comparable across frame sizes. */
  readonly perPixel: number;
  /** The most layers over one pixel. */
  readonly max: number;
}

/**
 * The overdraw of one frame, counted as the viewport's overdraw view does: the studio hides what
 * is behind it, the effects never hide each other. Each emitter and mesh is also counted alone,
 * so their fragments add up to the total; hidden ones are left out of both.
 */
export interface OverdrawReport extends OverdrawLayers {
  readonly width: number;
  readonly height: number;
  /** Emitters and meshes, most fragments first. */
  readonly byOwner: readonly (OverdrawLayers & { readonly id: string; readonly name: string })[];
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
  /** Counts a frame's overdraw. After a timed count the transport is left paused there. */
  overdraw(options: OverdrawOptions): Promise<OverdrawReport>;
}

export interface PreviewDependencies {
  readonly store: Store;
  readonly transport: TransportStore;
  readonly coordinator: Pick<SceneCoordinator, "advance" | "capture" | "measureOverdraw">;
  readonly focusEntity: (entity: SceneEntity) => void;
  /** The live viewport object of an entity, for framing a capture on it and counting it alone. */
  readonly entityObject: (entity: SceneEntity) => Object3D | undefined;
}

/** The fixed simulation step a timed capture replays with (the live loop's nominal rate). */
const SIMULATION_STEP = 1 / 60;
/** The largest capture edge accepted, in pixels. A weak GPU may still clamp the drawing buffer
 *  below it; the capture then comes back at the size actually rendered. */
const MAX_CAPTURE_SIZE = 4096;
/** Below this, a remaining interval is float noise rather than time left to simulate. */
const TIME_EPSILON = 1e-9;

const SHOT_OPTION_KEYS = ["width", "height", "camera", "frame"] as const;
const FRAME_OPTION_KEYS = [...SHOT_OPTION_KEYS, "clean", "ground", "background"] as const;
const OVERDRAW_COUNTS: readonly OverdrawCount[] = ["rasterized", "surviving"];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** The capture-only point of view `options` asks for, checked; `undefined` for the viewport's. */
function requireView(
  options: ShotOptions,
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

/** The coordinator's view of a shot's size and point of view, checked; `view` already resolved. */
function requireShot(options: ShotOptions, view: CaptureView | undefined): CaptureShot {
  const { width, height } = options;
  return {
    ...(width !== undefined || height !== undefined
      ? {
          size: {
            width: requireInteger("width", width, 1, MAX_CAPTURE_SIZE),
            height: requireInteger("height", height, 1, MAX_CAPTURE_SIZE),
          },
        }
      : {}),
    ...(view !== undefined ? { view } : {}),
  };
}

/** The coordinator's view of a frame's options, checked; `view` already resolved. */
function requireFrame(options: FrameOptions, view: CaptureView | undefined): FrameCaptureOptions {
  const { clean, ground, background } = options;
  if (clean !== undefined && typeof clean !== "boolean") {
    throw new AgentError("invalid_argument", "clean must be a boolean.");
  }
  if (ground !== undefined && typeof ground !== "boolean") {
    throw new AgentError("invalid_argument", "ground must be a boolean.");
  }
  if (background !== undefined && background !== "transparent" && !HEX_COLOR.test(background)) {
    throw new AgentError("invalid_argument", 'background must be "#rrggbb" or "transparent".');
  }
  return {
    ...requireShot(options, view),
    ...(clean === true ? { overlays: false, ground: ground === true } : {}),
    // three reads a hex string as sRGB and converts it to its linear working space.
    ...(background === undefined
      ? {}
      : { background: background === "transparent" ? "transparent" : new Color(background) }),
  };
}

function requireCount(value: unknown): OverdrawCount {
  const count = OVERDRAW_COUNTS.find((key) => key === value);
  if (count === undefined) {
    throw new AgentError("invalid_argument", 'count must be "rasterized" or "surviving".');
  }
  return count;
}

/** `stats`' layers, with `perPixel` over the whole frame. */
function layersOf(stats: OverdrawStats): OverdrawLayers {
  return {
    fragments: stats.fragments,
    perPixel: stats.fragments / (stats.width * stats.height),
    max: stats.max,
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

  /** Replays the timeline from 0, calling `take` once at each of `times` (ascending). */
  const replay = async <T>(
    times: readonly number[],
    take: () => T,
  ): Promise<{ readonly time: number; readonly value: T }[]> => {
    // Let a pending recompute land first, so its restart-on-rebuild can't rewind mid-replay.
    await settle();
    // Stop rewinds and lets the dispatcher clear live particles; play arms event dispatch.
    transport.stop();
    transport.play();
    const taken: { readonly time: number; readonly value: T }[] = [];
    try {
      let now = 0;
      for (const time of times) {
        while (time - now > TIME_EPSILON) {
          const next = Math.min(time, now + SIMULATION_STEP);
          transport.seek(next);
          coordinator.advance(next - now);
          now = next;
        }
        taken.push({ time, value: take() });
      }
    } finally {
      // Never leave the live loop running a replay that failed part-way.
      transport.pause();
    }
    return taken;
  };

  /** At `time`, or now when it is omitted, after any pending recompute lands. */
  const at = async <T>(time: number | undefined, take: () => T): Promise<T> => {
    if (time === undefined) {
      await settle();
      return take();
    }
    const [taken] = await replay([requireTime("time", time)], take);
    if (taken === undefined) {
      throw new AgentError("rejected", "The replay produced no frame.");
    }
    return taken.value;
  };

  /** The emitters and meshes shown in the viewport, each with its live object. */
  const shownOwners = (): { id: string; name: string; object: Object3D }[] => {
    const { scene } = store.getSource();
    const owners = [
      ...scene.emitters.map((emitter) => ({ ...emitter, kind: "emitter" as const })),
      ...scene.meshes.map((mesh) => ({ ...mesh, kind: "vfxMesh" as const })),
    ];
    return owners.flatMap(({ kind, id, name, hidden }) => {
      const object = hidden === true ? undefined : entityObject({ kind, id });
      return object === undefined ? [] : [{ id, name, object }];
    });
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
      const image = await at(options.time, () => coordinator.capture(frame));
      return image.toDataURL("image/png");
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
      const frames = await replay(times, () => coordinator.capture(frame));
      return composeSheet(
        frames.map(({ time, value }) => ({ time, image: value })),
        columns,
        options.background,
      ).toDataURL("image/png");
    },

    overdraw: async (options): Promise<OverdrawReport> => {
      requireKnownKeys("options", options, ["time", "count", ...SHOT_OPTION_KEYS]);
      const count = requireCount(options.count);
      const shot = requireShot(options, requireView(options, store.getSource(), entityObject));
      // Looked up at the counted frame: a recompute settled on the way rebuilds the objects.
      const { owners, total, parts } = await at(options.time, () => {
        const shown = shownOwners();
        const measured = coordinator.measureOverdraw(
          count,
          shot,
          shown.map((owner) => owner.object),
        );
        return { owners: shown, ...measured };
      });
      const byOwner = owners
        .map((owner, index) => {
          const stats = parts[index];
          return stats === undefined
            ? undefined
            : { id: owner.id, name: owner.name, ...layersOf(stats) };
        })
        .filter((entry) => entry !== undefined)
        .sort((first, second) => second.fragments - first.fragments);
      return { width: total.width, height: total.height, ...layersOf(total), byOwner };
    },
  };
}
