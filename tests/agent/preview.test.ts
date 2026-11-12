import { Color, Object3D, Vector3 } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPreviewApi } from "../../src/agent/preview";
import { createDefaultEmitter, createInitialState } from "../../src/model/editorState";
import { SignalBus } from "../../src/model/signals";
import { Store } from "../../src/model/store";
import { TransportStore } from "../../src/model/transport";
import type { FrameCaptureOptions } from "../../src/render/sceneCoordinator";

/** A preview API over a fake coordinator that records what each capture was asked to render. */
function previewWithRecorder() {
  const state = createInitialState();
  state.source = {
    ...state.source,
    scene: { ...state.source.scene, emitters: [createDefaultEmitter("emitter_1", "Emitter")] },
  };
  const store = new Store(state, new SignalBus());
  const transport = new TransportStore(() => store.getSource().timeline.duration);
  const requests: FrameCaptureOptions[] = [];
  const bolt = new Object3D();
  const steps: number[] = [];
  const preview = createPreviewApi({
    store,
    transport,
    coordinator: {
      advance: (delta) => steps.push(delta),
      capture: (options = {}) => {
        requests.push(options);
        return { width: 1, height: 1, toDataURL: () => "data:image/png;base64," } as never;
      },
    },
    focusEntity: () => {},
    entityObject: (entity) => (entity.kind === "emitter" ? bolt : undefined),
  });
  return { preview, transport, requests, steps, bolt };
}

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
    expect(request.ground).toBe(false);
    expect(request.background).toBeInstanceOf(Color);
    // The hex is sRGB; three keeps it linear, so pure red stays pure red.
    expect((request.background as Color).getHexString()).toBe("ff0000");
  });

  it("keeps the ground in a clean frame when asked, for shadows and depth fade", async () => {
    const { preview, requests } = previewWithRecorder();
    await preview.capture({ clean: true, ground: true });
    expect(requests[0]).toMatchObject({ overlays: false, ground: true });
    await expect(preview.capture({ clean: true, ground: "yes" } as never)).rejects.toThrow(
      /ground must be a boolean/,
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
      store: new Store(createInitialState(), new SignalBus()),
      transport,
      coordinator: {
        advance: () => {},
        capture: () => {
          throw new Error("GPU lost");
        },
      },
      focusEntity: () => {},
      entityObject: () => undefined,
    });
    await expect(failing.capture({ time: 0.2 })).rejects.toThrow(/GPU lost/);
    expect(transport.isPlaying()).toBe(false);
  });
});
