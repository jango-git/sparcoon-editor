/**
 * Samples a track at a time: held outside the keys, interpolated between them, componentwise for
 * vectors. Delegates to the runtime's sampling code so the editor and the export agree.
 */

import { sampleTrack as sharedSampleTrack } from "sparcoon/editor";

import type { AnimationTrack } from "./editorState";

export function sampleTrack(
  track: AnimationTrack,
  time: number,
): number | readonly number[] | undefined {
  return sharedSampleTrack(track, time);
}
