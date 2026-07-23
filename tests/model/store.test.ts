import { describe, expect, it } from "vitest";
import { createInitialState } from "../../src/model/editorState";
import { Store } from "../../src/model/store";
import { SignalBus } from "../../src/model/signals";

describe("Store: undo/redo re-announce the original commit kind", () => {
  it("emits sourceViewChanged (not structural) when undoing/redoing a view commit", () => {
    const signals = new SignalBus();
    const store = new Store(createInitialState(), signals);
    let structural = 0;
    let view = 0;
    signals.on("sourceStructureChanged", () => structural++);
    signals.on("sourceViewChanged", () => view++);

    store.commit(store.getSource(), "view");
    expect(view).toBe(1);
    expect(structural).toBe(0);

    store.undo();
    expect(view).toBe(2);
    expect(structural).toBe(0);

    store.redo();
    expect(view).toBe(3);
    expect(structural).toBe(0);
  });

  it("still emits sourceStructureChanged when undoing/redoing a structural commit", () => {
    const signals = new SignalBus();
    const store = new Store(createInitialState(), signals);
    let structural = 0;
    let view = 0;
    signals.on("sourceStructureChanged", () => structural++);
    signals.on("sourceViewChanged", () => view++);

    store.commit(store.getSource(), "structural");
    store.undo();
    store.redo();
    expect(structural).toBe(3);
    expect(view).toBe(0);
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
