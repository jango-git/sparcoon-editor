/**
 * Fires each authored `burst`/`play` event on its owning emitter's view as the transport playhead
 * crosses it. Notified every tick with no delta, so it remembers the last playhead and fires the
 * half-open interval `[lastTime, now)`; a backward jump (loop wrap) resets every emitter first.
 */

import type { AnimationTrack, SourceState } from "../model/editorState";
import { frameOf, timeOfFrame } from "../model/frames";
import type { Store } from "../model/store";
import { sampleTrack } from "../model/trackSampling";
import type { TransportStore } from "../model/transport";
import type { SceneEmitters } from "./sceneEmitters";

export class TimelineDispatcher {
  private lastTime = 0;
  // The frame the value/transform drive last ran for; `undefined` forces the first tick. The
  // drive is frame-stepped - re-runs only when the caret crosses into a new frame (scrub or play).
  private lastAppliedFrame: number | undefined = undefined;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly store: Store,
    private readonly transport: TransportStore,
    private readonly emitters: SceneEmitters,
    private readonly duration: () => number,
  ) {
    this.unsubscribe = transport.subscribe(() => this.onTransport());
  }

  public destroy(): void {
    this.unsubscribe();
  }

  private onTransport(): void {
    const now = this.transport.getTime();
    // Spawns fire across the continuous interval the caret swept (see dispatchSpawns) - they are
    // not frame-stepped.
    this.dispatchSpawns(now);
    // Value + transform drive are frame-stepped: re-run only on entering a new frame, sampled at
    // that frame's canonical time - moving within a frame updates nothing.
    const fps = this.store.getSource().timeline.fps;
    const frame = frameOf(now, fps);
    if (frame === this.lastAppliedFrame) {
      return;
    }
    this.lastAppliedFrame = frame;
    const frameTime = timeOfFrame(frame, fps);
    this.driveValues(frameTime);
    // A frame entry reasserts the timeline over any parked manual pose (gizmo drag).
    this.emitters.clearManualPoses();
    this.emitters.applySceneTransforms(this.store.getSource().scene, frameTime);
  }

  /** Fires burst/play events the playhead crossed since the last tick (only while playing). */
  private dispatchSpawns(now: number): void {
    if (!this.transport.isPlaying()) {
      // Stop rewinds the playhead to 0 -> reset so a fresh play replays from the top.
      // Pause holds the playhead where it is -> keep particles, just resync our cursor.
      if (now === 0) {
        this.rewind();
      } else {
        this.lastTime = now;
      }
      return;
    }

    if (now < this.lastTime) {
      // The loop wrapped: finish the events between the old playhead and the end, then
      // reset and fall through to fire the new lap from 0.
      this.fire(this.lastTime, this.duration());
      this.rewind();
    }
    this.fire(this.lastTime, now);
    this.lastTime = now;
  }

  /** Samples each emitter's and mesh's value tracks at `now` and scrubs them into its runtime object. */
  private driveValues(now: number): void {
    const source: SourceState = this.store.getSource();
    for (const emitter of source.scene.emitters) {
      // Always call - an empty map reverts params that just lost their last keyframe.
      this.emitters.driveParamValues(emitter.id, sampleTracks(emitter.tracks, now));
    }
    // Meshes carry only render-graph Timeline Values (no events, no behavior); same value-drive.
    for (const mesh of source.scene.meshes) {
      this.emitters.driveMeshParamValues(mesh.id, sampleTracks(mesh.tracks, now));
    }
  }

  /** Clears every emitter and parks the cursor at 0, ready to replay a lap from the start. */
  private rewind(): void {
    this.emitters.resetAll();
    this.lastTime = 0;
  }

  /** Fires every event whose time lies in `[from, to)` on its owning emitter's view. */
  private fire(from: number, to: number): void {
    if (to <= from) {
      return;
    }
    const source: SourceState = this.store.getSource();
    for (const emitter of source.scene.emitters) {
      for (const event of emitter.events) {
        if (event.time < from || event.time >= to) {
          continue;
        }
        if (event.kind === "burst") {
          this.emitters.burst(emitter.id, event.count);
        } else {
          this.emitters.play(emitter.id, event.rate, event.duration);
        }
      }
    }
  }
}

/** Samples every value track at `now` into a name -> value map (a track with no value is skipped). */
function sampleTracks(
  tracks: readonly AnimationTrack[],
  now: number,
): ReadonlyMap<string, number | readonly number[]> {
  const values = new Map<string, number | readonly number[]>();
  for (const track of tracks) {
    const value = sampleTrack(track, now);
    if (value !== undefined) {
      values.set(track.name, value);
    }
  }
  return values;
}
