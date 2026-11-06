import { afterEach, describe, expect, it, vi } from "vitest";
import { TransportStore } from "../../src/model/transport";
import { deserializeProject, serializeProject } from "../../src/persistence/projectFile";
import { createInitialState } from "../../src/model/editorState";

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

describe("timeline loop persistence", () => {
  it("loads a project saved before the setting existed as looping, and keeps an explicit off", () => {
    const source = createInitialState().source;
    const legacy = JSON.parse(serializeProject(source)) as {
      source: { timeline: Record<string, unknown> };
    };
    delete legacy.source.timeline["loop"];
    expect(deserializeProject(JSON.stringify(legacy))?.timeline.loop).toBe(true);

    const once = { ...source, timeline: { ...source.timeline, loop: false } };
    expect(deserializeProject(serializeProject(once))?.timeline.loop).toBe(false);
  });
});
