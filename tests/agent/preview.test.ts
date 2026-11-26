import { Color, Object3D, Vector3 } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPreviewApi } from "../../src/agent/preview";
import { createDefaultEmitter, createInitialState } from "../../src/model/editorState";
import { Store } from "../../src/model/store";
import { TransportStore } from "../../src/model/transport";
import { DEFAULT_VIEWPORT_VIEW } from "../../src/model/viewportView";
import type { OverdrawStats } from "../../src/render/overdrawPass";
import type {
  CaptureShot,
  FrameCaptureOptions,
  SceneCoordinator,
} from "../../src/render/sceneCoordinator";

/** A preview API over a fake coordinator that records what each capture was asked to render. */
function previewWithRecorder() {
  const state = createInitialState();
  state.source = {
    ...state.source,
    scene: {
      ...state.source.scene,
      emitters: [
        createDefaultEmitter("emitter_1", "Emitter"),
        createDefaultEmitter("emitter_2", "Smoke"),
        { ...createDefaultEmitter("emitter_3", "Muted"), hidden: true },
      ],
    },
  };
  const store = new Store(state);
  const transport = new TransportStore(() => store.getSource().timeline.duration);
  const requests: FrameCaptureOptions[] = [];
  const bolt = new Object3D();
  const objects = new Map<string, Object3D>([
    ["emitter_1", bolt],
    ["emitter_2", new Object3D()],
    ["emitter_3", new Object3D()],
  ]);
  const steps: number[] = [];
  const counted: { count: string; shot: CaptureShot; parts: readonly Object3D[] }[] = [];
  const views: Parameters<SceneCoordinator["setView"]>[0][] = [];
  // 10x10 frames: the first part draws 30 fragments, the second 120.
  const stats = (fragments: number, max: number): OverdrawStats => ({
    width: 10,
    height: 10,
    fragments,
    covered: Math.min(fragments, 100),
    max,
  });
  const preview = createPreviewApi({
    store,
    transport,
    coordinator: {
      advance: (delta) => steps.push(delta),
      capture: (options = {}) => {
        requests.push(options);
        return { width: 1, height: 1, toDataURL: () => "data:image/png;base64," } as never;
      },
      measureOverdraw: (count, shot, parts) => {
        counted.push({ count, shot, parts });
        return { total: stats(150, 9), parts: [stats(30, 2), stats(120, 7)] };
      },
      getView: () => ({ position: [0, 2, 7], target: [0, 0, 0], fov: 50 }),
      setView: (view) => views.push(view),
    },
    focusEntity: () => {},
    entityObject: (entity) => (entity.kind === "emitter" ? objects.get(entity.id) : undefined),
  });
  return { preview, transport, requests, steps, bolt, counted, objects, views };
}

describe("agent preview viewport camera", () => {
  it("reads the viewport camera and places it, keeping the fov when it is omitted", () => {
    const { preview, views } = previewWithRecorder();
    expect(preview.getView()).toEqual({ position: [0, 2, 7], target: [0, 0, 0], fov: 50 });
    preview.setView({ position: [1, 2, 3], target: [0, 1, 0] });
    preview.setView({ position: [1, 2, 3], target: [0, 1, 0], fov: 35 });
    expect(views[0].position).toEqual([1, 2, 3]);
    expect(views[0].target).toEqual([0, 1, 0]);
    expect(views[0].fov).toBeUndefined();
    expect(views[1].fov).toBe(35);
  });

  it("rejects a malformed view", () => {
    const { preview, views } = previewWithRecorder();
    expect(() => preview.setView({ position: [1, 2], target: [0, 0, 0] })).toThrow(/view.position/);
    expect(() => preview.setView({ position: [1, 2, 3], target: [0, 0, 0], fov: 180 })).toThrow(
      /view.fov/,
    );
    expect(() =>
      preview.setView({ position: [1, 2, 3], target: [0, 0, 0], zoom: 2 } as never),
    ).toThrow();
    expect(views).toHaveLength(0);
  });
});

describe("agent preview captures", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback): number => {
      setTimeout(() => callback(0), 0);
      return 0;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("turns clean and a hex background into a frame without overlays on that color", async () => {
    const { preview, requests } = previewWithRecorder();
    await preview.capture({ width: 64, height: 32, clean: true, background: "#ff0000" });
    const [request] = requests;
    expect(request.size).toEqual({ width: 64, height: 32 });
    expect(request.overlays).toBe(false);
    expect(request.scene).toBe(false);
    expect(request.background).toBeInstanceOf(Color);
    // The hex is sRGB; three keeps it linear, so pure red stays pure red.
    expect((request.background as Color).getHexString()).toBe("ff0000");
  });

  it("keeps the scene in a clean frame when asked, for shadows and depth fade", async () => {
    const { preview, requests } = previewWithRecorder();
    await preview.capture({ clean: true, scene: true });
    expect(requests[0]).toMatchObject({ overlays: false, scene: true });
    await expect(preview.capture({ clean: true, scene: "yes" } as never)).rejects.toThrow(
      /scene must be a boolean/,
    );
  });

  it("passes transparent through and leaves overlays on unless asked", async () => {
    const { preview, requests } = previewWithRecorder();
    await preview.capture({ background: "transparent" });
    expect(requests[0]).toEqual({ background: "transparent" });
  });

  it("rejects a background it cannot read and an unknown option", async () => {
    const { preview } = previewWithRecorder();
    await expect(preview.capture({ background: "red" })).rejects.toThrow(/#rrggbb/);
    await expect(preview.capture({ clear: true } as never)).rejects.toThrow(/no "clear"/);
    await expect(preview.capture({ width: 10 })).rejects.toThrow(/height/);
  });

  it("turns a camera into a capture-only look view", async () => {
    const { preview, requests } = previewWithRecorder();
    await preview.capture({ camera: { position: [0, 0.2, 0.5], target: [0, 0, 0], fov: 30 } });
    const view = requests[0].view;
    expect(view?.kind).toBe("look");
    if (view?.kind === "look") {
      expect(view.position).toEqual(new Vector3(0, 0.2, 0.5));
      expect(view.target).toEqual(new Vector3(0, 0, 0));
      expect(view.fov).toBe(30);
    }
  });

  it("frames an entity's live object at the given radius", async () => {
    const { preview, requests, bolt } = previewWithRecorder();
    await preview.capture({ frame: { entity: "emitter_1", radius: 0.05 } });
    expect(requests[0].view).toEqual({ kind: "frame", object: bolt, radius: 0.05 });
  });

  it("rejects camera and frame together, a bad radius, and an entity with nothing to frame", async () => {
    const { preview } = previewWithRecorder();
    await expect(
      preview.capture({
        camera: { position: [0, 0, 1], target: [0, 0, 0] },
        frame: { radius: 1 },
      }),
    ).rejects.toThrow(/not both/);
    await expect(preview.capture({ frame: { radius: 0 } })).rejects.toThrow(/positive/);
    // The fake viewport has no object for the VFX group.
    await expect(preview.capture({ frame: { radius: 1 } })).rejects.toThrow(
      /nothing in the viewport/,
    );
    await expect(
      preview.capture({ camera: { position: [0, 0, 1], target: [0, 0, 0], fov: 200 } }),
    ).rejects.toThrow(/fov/);
  });

  it("replays to the requested time in fixed steps and leaves the transport paused there", async () => {
    const { preview, transport, steps } = previewWithRecorder();
    await preview.capture({ time: 0.5 });
    expect(steps.reduce((total, step) => total + step, 0)).toBeCloseTo(0.5);
    expect(Math.max(...steps)).toBeCloseTo(1 / 60);
    expect(transport.isPlaying()).toBe(false);
    expect(transport.getTime()).toBeCloseTo(0.5);
  });

  it("pauses the transport even when a capture fails mid-replay", async () => {
    const { transport } = previewWithRecorder();
    const failing = createPreviewApi({
      store: new Store(createInitialState()),
      transport,
      coordinator: {
        advance: () => {},
        capture: () => {
          throw new Error("GPU lost");
        },
        measureOverdraw: () => {
          throw new Error("GPU lost");
        },
        getView: () => DEFAULT_VIEWPORT_VIEW,
        setView: () => {},
      },
      focusEntity: () => {},
      entityObject: () => undefined,
    });
    await expect(failing.capture({ time: 0.2 })).rejects.toThrow(/GPU lost/);
    expect(transport.isPlaying()).toBe(false);
  });
});

describe("agent preview overdraw", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback): number => {
      setTimeout(() => callback(0), 0);
      return 0;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("counts the shown owners alone, most fragments first, per pixel of the frame", async () => {
    const { preview, counted, objects } = previewWithRecorder();
    const report = await preview.overdraw({ count: "rasterized", width: 10, height: 10 });
    const [request] = counted;
    expect(request.count).toBe("rasterized");
    expect(request.shot.size).toEqual({ width: 10, height: 10 });
    // The hidden emitter is left out.
    expect(request.parts).toEqual([objects.get("emitter_1"), objects.get("emitter_2")]);
    expect(report).toMatchObject({ width: 10, height: 10, fragments: 150, perPixel: 1.5, max: 9 });
    expect(report.byOwner).toEqual([
      { id: "emitter_2", name: "Smoke", fragments: 120, perPixel: 1.2, max: 7 },
      { id: "emitter_1", name: "Emitter", fragments: 30, perPixel: 0.3, max: 2 },
    ]);
  });

  it("replays to the requested time and leaves the transport paused there", async () => {
    const { preview, transport, steps } = previewWithRecorder();
    await preview.overdraw({ count: "surviving", time: 0.5 });
    expect(steps.reduce((total, step) => total + step, 0)).toBeCloseTo(0.5);
    expect(transport.isPlaying()).toBe(false);
    expect(transport.getTime()).toBeCloseTo(0.5);
  });

  it("rejects an unknown count and the capture-only look options", async () => {
    const { preview } = previewWithRecorder();
    await expect(preview.overdraw({ count: "all" as never })).rejects.toThrow(/count/);
    await expect(preview.overdraw({ count: "rasterized", clean: true } as never)).rejects.toThrow(
      /clean/,
    );
  });
});
