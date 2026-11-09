import { vi } from "vitest";
import { createInitialState, type TimelineEvent } from "../../src/model/editorState";
import { SignalBus } from "../../src/model/signals";
import { Store } from "../../src/model/store";
import { TransportStore } from "../../src/model/transport";
import type { SceneEmitters } from "../../src/render/sceneEmitters";
import { TimelineDispatcher } from "../../src/render/timelineDispatcher";

/** The part of {@link SceneEmitters} the dispatcher drives, each a spy. */
export interface SpyViews {
  readonly applySceneTransforms: ReturnType<typeof vi.fn>;
  readonly driveParamValues: ReturnType<typeof vi.fn>;
  readonly driveMeshParamValues: ReturnType<typeof vi.fn>;
  readonly clearManualPoses: ReturnType<typeof vi.fn>;
  readonly resetAll: ReturnType<typeof vi.fn>;
  readonly loopAll: ReturnType<typeof vi.fn>;
  readonly spawn: ReturnType<typeof vi.fn>;
}

export interface DispatcherHarness {
  readonly transport: TransportStore;
  readonly views: SpyViews;
  /** Runs the transport's animation-frame callback at `timestamp` (ms). */
  readonly tick: (timestamp: number) => void;
}

/**
 * A {@link TimelineDispatcher} over the starter's 5 s, 30 fps timeline, its one emitter carrying
 * `events`, driving spy views. Playback needs {@link stubAnimationFrames} first.
 */
export function dispatcherHarness(events: readonly TimelineEvent[] = []): DispatcherHarness {
  const state = createInitialState();
  const [emitter] = state.source.scene.emitters;
  state.source = {
    ...state.source,
    scene: { ...state.source.scene, emitters: [{ ...emitter, events }] },
  };
  const store = new Store(state, new SignalBus());
  const transport = new TransportStore(() => store.getSource().timeline.duration);
  const views: SpyViews = {
    applySceneTransforms: vi.fn(),
    driveParamValues: vi.fn(),
    driveMeshParamValues: vi.fn(),
    clearManualPoses: vi.fn(),
    resetAll: vi.fn(),
    loopAll: vi.fn(),
    spawn: vi.fn(),
  };
  new TimelineDispatcher(
    store,
    transport,
    views as unknown as SceneEmitters,
    () => store.getSource().timeline.duration,
  );
  const tick = (timestamp: number): void =>
    (transport as unknown as { tick(timestamp: number): void }).tick(timestamp);
  return { transport, views, tick };
}

/** Animation frames that never fire on their own, so a test steps playback with `tick`. Undo with
 *  `vi.unstubAllGlobals()`. */
export function stubAnimationFrames(): void {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
}
