import { describe, expect, it } from "vitest";

import { createInitialState } from "../../src/model/editorState";
import { SignalBus } from "../../src/model/signals";
import { Store } from "../../src/model/store";

describe("Store: undo/redo re-announce the original commit kind", () => {
  it.each([
    { kind: "view", signal: "sourceViewChanged", other: "sourceStructureChanged" },
    { kind: "structural", signal: "sourceStructureChanged", other: "sourceViewChanged" },
  ] as const)("re-emits $signal, never $other, for a $kind commit", ({ kind, signal, other }) => {
    const signals = new SignalBus();
    const store = new Store(createInitialState(), signals);
    let announced = 0;
    let crossed = 0;
    signals.on(signal, () => announced++);
    signals.on(other, () => crossed++);

    store.commit(store.getSource(), kind);
    expect(announced).toBe(1);
    store.undo();
    expect(announced).toBe(2);
    store.redo();
    expect(announced).toBe(3);
    expect(crossed).toBe(0);
  });
});

describe("Store.commitLive: applies without touching history", () => {
  it("updates the source and fires the kind's signal, but never historyChanged", () => {
    const signals = new SignalBus();
    const store = new Store(createInitialState(), signals);
    let structural = 0;
    let historyChanged = 0;
    signals.on("sourceStructureChanged", () => structural++);
    signals.on("historyChanged", () => historyChanged++);

    store.commitLive(store.getSource(), "structural");

    expect(structural).toBe(1);
    expect(historyChanged).toBe(0);
    expect(store.canUndo).toBe(false);
  });

  it("several live calls plus one final commit record exactly one undo step for the whole gesture", () => {
    const signals = new SignalBus();
    const store = new Store(createInitialState(), signals);
    const initial = store.getSource();

    // Simulate a scrub drag: many intermediate live steps (no history), then one commit at release.
    store.commitLive(initial, "structural");
    store.commitLive(initial, "structural");
    store.commitLive(initial, "structural");
    store.commit(initial, "structural");

    expect(store.canUndo).toBe(true);
    store.undo();
    // Exactly one step back to the pre-gesture state - not one per live call.
    expect(store.canUndo).toBe(false);
    expect(store.canRedo).toBe(true);
  });
});
