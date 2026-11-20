/**
 * Conversions between seconds and the frame grid set by `TimelineState.fps`, delegating to the
 * runtime's sampling code so the editor and the export agree.
 */

import { frameOfTime, timeOfFrame as sharedTimeOfFrame } from "sparcoon/editor";

/** The frame index nearest to time `t` (seconds) at `fps` frames/second. */
export function frameOf(time: number, fps: number): number {
  return frameOfTime(time, fps);
}

/** The start time (seconds) of frame `frame` at `fps` frames/second. */
export function timeOfFrame(frame: number, fps: number): number {
  return sharedTimeOfFrame(frame, fps);
}

/** `t` (seconds) snapped to the nearest frame boundary; unchanged when there is no grid. */
export function snapTimeToFrame(time: number, fps: number): number {
  return fps > 0 ? Math.round(time * fps) / fps : time;
}

/** Whole frames a `duration`-second timeline spans at `fps` (at least one). */
export function frameCount(duration: number, fps: number): number {
  return fps > 0 ? Math.max(1, Math.round(duration * fps)) : 1;
}
