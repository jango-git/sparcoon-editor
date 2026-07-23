/**
 * Samples an {@link AnimationTrack} at a point in time (held before/after, lerped between,
 * componentwise for vectors); delegates to sparcoon's `FXEffectSampling.Internal.ts` so the editor and exported runtime always agree.
 */

import { sampleTrack as sharedSampleTrack } from "sparcoon/editor";
import type { AnimationTrack } from "./editorState";

/** The interpolated value of `track` at time `time`, or `undefined` if the track has no keys. */
export function sampleTrack(
  track: AnimationTrack,
  time: number,
): number | readonly number[] | undefined {
  return sharedSampleTrack(track, time);
}
