import { describe, expect, it, vi } from "vitest";
import { createInitialState } from "../../src/model/editorState";
import { Store } from "../../src/model/store";
import { SignalBus } from "../../src/model/signals";
import { timeOfFrame } from "../../src/model/frames";
import { TransportStore } from "../../src/model/transport";
import { TimelineDispatcher } from "../../src/render/timelineDispatcher";
import type { SceneEmitters } from "../../src/render/sceneEmitters";

function harness(): {
  transport: TransportStore;
  applySceneTransforms: ReturnType<typeof vi.fn>;
  driveParamValues: ReturnType<typeof vi.fn>;
} {
  const store = new Store(createInitialState(), new SignalBus());
  const transport = new TransportStore(() => store.getSource().timeline.duration);
  const applySceneTransforms = vi.fn();
  const driveParamValues = vi.fn();
  const emitters = {
    applySceneTransforms,
    driveParamValues,
    driveMeshParamValues: vi.fn(),
    resetAll: vi.fn(),
    burst: vi.fn(),
    play: vi.fn(),
    clearManualPoses: vi.fn(),
  } as unknown as SceneEmitters;
  new TimelineDispatcher(store, transport, emitters, () => store.getSource().timeline.duration);
  return { transport, applySceneTransforms, driveParamValues };
}

// createInitialState uses fps=30, so frame 0 spans t in [0, 1/60), frame 1 in [1/60, 3/60), etc.
describe("TimelineDispatcher: frame-stepped drive", () => {
  it("drives once on entering a frame, and again only on the next frame", () => {
    const { transport, applySceneTransforms, driveParamValues } = harness();

    transport.seek(0.01); // -> frame 0
    expect(applySceneTransforms).toHaveBeenCalledTimes(1);
    expect(driveParamValues).toHaveBeenCalledTimes(1);

    transport.seek(0.015); // still frame 0: the caret moved within the frame -> no re-drive
    expect(applySceneTransforms).toHaveBeenCalledTimes(1);
    expect(driveParamValues).toHaveBeenCalledTimes(1);

    transport.seek(0.02); // -> frame 1: a frame entry re-drives
    expect(applySceneTransforms).toHaveBeenCalledTimes(2);
    expect(driveParamValues).toHaveBeenCalledTimes(2);
  });

  it("samples at the frame's canonical time, not the raw caret time", () => {
    const { transport, applySceneTransforms } = harness();

    transport.seek(0.02); // frame 1, raw time 0.02
    // The drive samples at timeOfFrame(1) = 1/30, not the 0.02 the caret happens to sit at.
    expect(applySceneTransforms.mock.calls[0][1]).toBeCloseTo(timeOfFrame(1, 30), 6);

    transport.seek(0.05); // frame 2
    expect(applySceneTransforms.mock.calls[1][1]).toBeCloseTo(timeOfFrame(2, 30), 6);
  });
});

describe("TimelineDispatcher: playing drive", () => {
  // Playback ticks off requestAnimationFrame; a stub keeps the tests in charge of the playhead.
  function playing(): ReturnType<typeof harness> {
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const parts = harness();
    parts.transport.play();
    parts.applySceneTransforms.mockClear();
    parts.driveParamValues.mockClear();
    return parts;
  }

  it("poses on every tick at the caret time itself, within a frame too", () => {
    const { transport, applySceneTransforms } = playing();

    transport.seek(0.01); // frame 0
    transport.seek(0.012); // still frame 0: a pose that held here would read as no motion
    transport.seek(0.02); // frame 1

    expect(applySceneTransforms.mock.calls.map((call) => call[1] as number)).toEqual([
      0.01, 0.012, 0.02,
    ]);
    vi.unstubAllGlobals();
  });

  it("keeps the value drive frame-stepped", () => {
    const { transport, driveParamValues } = playing();

    transport.seek(0.01); // frame 0 (already driven when play started: no re-drive)
    transport.seek(0.012);
    transport.seek(0.02); // frame 1: one value drive

    expect(driveParamValues).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
