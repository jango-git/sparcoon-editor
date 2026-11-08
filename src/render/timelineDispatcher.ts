/**
 * Fires each authored `burst`/`play` event on its owning emitter's view as the transport playhead
 * crosses it, and drives the timeline's poses and values into the views. Notified every tick with
 * no delta, so it remembers the last playhead and fires the half-open interval `[lastTime, now)`.
 * Playback looping back to the start runs on seamlessly, live particles kept; a seek backwards
 * while playing replays from the top, cleared. Same order and loop as the runtime's `FXEffect`.
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
   * Drives values for the frame `time` falls in, sampled at that frame's canonical time -
   * frame-stepped, so moving within a frame updates nothing. Poses follow the same grid while the
   * caret is parked or scrubbed, but while playing they are sampled at `time` itself on every tick:
   * a pose held still between two frames would read as no motion on each tick between them (and as
   * a jump on the next) to anything reading an emitter's velocity. Spawns fire across the continuous
   * interval the caret swept (see dispatchSpawns). Same drive as the runtime's `FXEffect`.
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
      // Seeked backwards while playing (a loop is handled before this): replay from the top.
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
