import { afterEach, describe, expect, it, vi } from "vitest";
import { createInitialState, type TimelineEvent } from "../../src/model/editorState";
import { SignalBus } from "../../src/model/signals";
import { Store } from "../../src/model/store";
import { TransportStore } from "../../src/model/transport";
import type { SceneEmitters } from "../../src/render/sceneEmitters";
import { TimelineDispatcher } from "../../src/render/timelineDispatcher";

/** The 5 s starter timeline, its one emitter carrying `events`, and a log of what the views got. */
function harness(events: readonly TimelineEvent[]) {
  const state = createInitialState();
  const [emitter] = state.source.scene.emitters;
  state.source = {
    ...state.source,
    scene: { ...state.source.scene, emitters: [{ ...emitter, events }] },
  };
  const store = new Store(state, new SignalBus());
  const transport = new TransportStore(() => store.getSource().timeline.duration);
  const log: string[] = [];
  const emitters = {
    // Rounded: while playing, poses sample the raw caret time (a lap wrap leaves float noise).
    applySceneTransforms: vi.fn((_scene: unknown, time: number) =>
      log.push(`pose ${String(Number(time.toFixed(6)))}`),
    ),
    driveParamValues: vi.fn(),
    driveMeshParamValues: vi.fn(),
    clearManualPoses: vi.fn(),
    resetAll: vi.fn(() => log.push("reset")),
    loopAll: vi.fn(() => log.push("loop")),
    burst: vi.fn((_id: string, count: number) => log.push(`burst ${count}`)),
    play: vi.fn(),
  } as unknown as SceneEmitters;
  new TimelineDispatcher(store, transport, emitters, () => store.getSource().timeline.duration);
  // Playback is driven by animation frames; step them by hand.
  const tick = (timestamp: number): void =>
    (transport as unknown as { tick(timestamp: number): void }).tick(timestamp);
  return { transport, log, tick };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubAnimationFrames(): void {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
}

describe("TimelineDispatcher: loop and order", () => {
  it("poses the frame before firing its bursts", () => {
    stubAnimationFrames();
    const { transport, log, tick } = harness([{ id: "b", kind: "burst", time: 1, count: 3 }]);
    transport.play();
    tick(0);
    log.length = 0;
    tick(1100); // 0 -> 1.1 s: enters frame 33 and crosses the burst at 1 s
    expect(log).toEqual(["pose 1.1", "burst 3"]);
  });

  it("loops seamlessly: fires the lap's tail from its last pose and clears nothing", () => {
    stubAnimationFrames();
    const { transport, log, tick } = harness([
      { id: "tail", kind: "burst", time: 4.95, count: 2 },
      { id: "head", kind: "burst", time: 0, count: 5 },
    ]);
    transport.play();
    tick(0);
    tick(4900); // 0 -> 4.9 s
    log.length = 0;
    tick(5100); // 4.9 -> 5.1 s: wraps to 0.1 s
    expect(log).toEqual(["pose 5", "burst 2", "loop", "pose 0.1", "burst 5"]);
  });

  it("clears and replays from the top on a seek backwards while playing", () => {
    stubAnimationFrames();
    const { transport, log, tick } = harness([{ id: "b", kind: "burst", time: 0.5, count: 4 }]);
    transport.play();
    tick(0);
    tick(2000); // 0 -> 2 s
    log.length = 0;
    transport.seek(1); // back to 1 s: cleared, then [0, 1) replays, burst included
    expect(log).toEqual(["pose 1", "reset", "burst 4"]);
  });
});
