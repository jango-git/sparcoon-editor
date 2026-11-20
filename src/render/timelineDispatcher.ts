/**
 * Fires `burst`/`play` events when the playhead crosses them and drives poses and values into the
 * views. Fires the half-open interval `[lastTime, now)`. A loop continues with live particles kept.
 * A backward seek while playing replays from the top, cleared.
 */

import type { AnimationTrack, SourceState } from "../model/editorState";
import { frameOf, timeOfFrame } from "../model/frames";
import type { Store } from "../model/store";
import { sampleTrack } from "../model/trackSampling";
import type { TransportStore } from "../model/transport";
import type { SceneEmitters } from "./sceneEmitters";

export class TimelineDispatcher {
  private lastTime = 0;
  private lastLap = 0;
  // The frame the value drive (and a parked caret's pose) last ran for; `undefined` forces the
  // first tick. Values are frame-stepped - re-driven only when the caret crosses into a new frame.
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
    const lap = this.transport.getLap();
    if (lap !== this.lastLap) {
      this.lastLap = lap;
      // Looped: finish this lap's tail from the lap's last pose, then run on into the next lap
      // without clearing what is alive.
      this.driveFrame(this.duration());
      this.fire(this.lastTime, this.duration());
      this.emitters.loopAll();
      this.lastTime = 0;
    }
    // Pose and values first, spawns second: a burst spawns from the emitter's pose and values at
    // the moment it fires, so this frame's bursts must see this frame's pose.
    this.driveFrame(now);
    this.dispatchSpawns(now);
  }

  /**
   * Values are sampled once per frame, at the frame's time. Poses follow the same grid while parked
   * or scrubbed. While playing they are sampled at `time`, so velocity stays continuous. Spawns
   * fire over the continuous interval swept (see dispatchSpawns).
   */
  private driveFrame(time: number): void {
    const fps = this.store.getSource().timeline.fps;
    const frame = frameOf(time, fps);
    const playing = this.transport.isPlaying();
    const entered = frame !== this.lastAppliedFrame;
    if (entered) {
      this.lastAppliedFrame = frame;
      this.driveValues(timeOfFrame(frame, fps));
      // A frame entry reasserts the timeline over any parked manual pose (gizmo drag).
      this.emitters.clearManualPoses();
    }
    if (playing) {
      this.emitters.applySceneTransforms(this.store.getSource().scene, time);
    } else if (entered) {
      this.emitters.applySceneTransforms(this.store.getSource().scene, timeOfFrame(frame, fps));
    }
  }

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
      // Seeked backwards while playing (a loop is handled before this): replay from the top.
      this.rewind();
    }
    this.fire(this.lastTime, now);
    this.lastTime = now;
  }

  private driveValues(now: number): void {
    const source: SourceState = this.store.getSource();
    for (const emitter of source.scene.emitters) {
      // Always call - an empty map reverts params that just lost their last keyframe.
      this.emitters.driveParamValues(emitter.id, sampleTracks(emitter.tracks, now));
    }
    for (const mesh of source.scene.meshes) {
      this.emitters.driveMeshParamValues(mesh.id, sampleTracks(mesh.tracks, now));
    }
  }

  private rewind(): void {
    this.emitters.resetAll();
    this.lastTime = 0;
  }

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
        this.emitters.spawn(emitter.id, event);
      }
    }
  }
}

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
