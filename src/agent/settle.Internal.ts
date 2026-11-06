/**
 * Waiting for the editor to catch up with an edit. A commit schedules the recompute on the next
 * animation frame; waiting two covers it and the rebind that follows. A texture still decoding is
 * not awaited (the registry offers nothing to wait on): it rebinds whenever its decode lands, which
 * for an image `assets.add` just decoded once is normally within these frames.
 */

export function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

export async function settle(): Promise<void> {
  await nextFrame();
  await nextFrame();
}
