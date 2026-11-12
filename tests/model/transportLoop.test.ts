import { afterEach, describe, expect, it, vi } from "vitest";

import { TransportStore } from "../../src/model/transport";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A transport over a 1 s timeline whose animation frames are stepped by hand. */
function transport(loops: boolean) {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  const store = new TransportStore(
    () => 1,
    () => false,
    () => loops,
  );
  const tick = (timestamp: number): void =>
    (store as unknown as { tick(timestamp: number): void }).tick(timestamp);
  store.play();
  tick(0);
  return { store, tick };
}

describe("TransportStore loop", () => {
  it("wraps a looping timeline and counts the lap", () => {
    const { store, tick } = transport(true);
    tick(1200);
    expect(store.getTime()).toBeCloseTo(0.2);
    expect(store.getLap()).toBe(1);
  });

  it("parks a once-through timeline on its last frame, still playing", () => {
    const { store, tick } = transport(false);
    tick(1200);
    expect(store.getTime()).toBe(1);
    expect(store.getLap()).toBe(0);
    expect(store.isPlaying()).toBe(true);
  });
});

describe("TransportStore seek, stop and restart", () => {
  it("clamps a seek to the timeline, and notifies only when the playhead moves", () => {
    const store = new TransportStore(() => 1);
    const notified = vi.fn();
    store.subscribe(notified);
    store.seek(2);
    expect(store.getTime()).toBe(1);
    store.seek(5);
    expect(notified).toHaveBeenCalledTimes(1);
    store.seek(-1);
    expect(store.getTime()).toBe(0);
    expect(notified).toHaveBeenCalledTimes(2);
  });

  it("stops by pausing and rewinding, a no-op once stopped at the start", () => {
    const { store, tick } = transport(true);
    tick(400);
    const notified = vi.fn();
    store.subscribe(notified);
    store.stop();
    expect(store.isPlaying()).toBe(false);
    expect(store.getTime()).toBe(0);
    expect(notified).toHaveBeenCalledTimes(1);
    store.stop();
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it("restarts from the start, keeping the play state", () => {
    const { store, tick } = transport(true);
    tick(400);
    store.restart();
    expect(store.getTime()).toBe(0);
    expect(store.isPlaying()).toBe(true);

    store.pause();
    store.seek(0.5);
    store.restart();
    expect(store.getTime()).toBe(0);
    expect(store.isPlaying()).toBe(false);
  });
});
