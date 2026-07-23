import { describe, expect, it } from "vitest";
import { createInitialState } from "../../src/model/editorState";
import { Store } from "../../src/model/store";
import { SignalBus } from "../../src/model/signals";
import { addNode, updateNodeParam } from "../../src/model/commands";
import type { GraphNode } from "../../src/domain/graphModel";

const freshStore = (): Store => new Store(createInitialState(), new SignalBus());

const timelineValue = (id: string, name: string): GraphNode => ({
  id,
  type: "timeline-value",
  parameters: { name, value: 1 },
  position: { x: 0, y: 0 },
});

const paramValue = (store: Store, id: string): unknown =>
  store.getSource().scene.emitters[0].renderGraph.nodes[id].parameters["value"];

describe("updateNodeParam: live edits", () => {
  it("applies the value but records no new history entry when live is true", () => {
    const store = freshStore();
    addNode(store, "renderGraph", timelineValue("tv1", "size"));
    const undoDepthAfterAdd = countUndoSteps(store);

    updateNodeParam(store, "renderGraph", "tv1", "value", 5, true);

    expect(paramValue(store, "tv1")).toBe(5);
    expect(countUndoSteps(store)).toBe(undoDepthAfterAdd);
  });

  it("several live steps plus a final non-live commit record exactly one undo step for the whole gesture", () => {
    const store = freshStore();
    addNode(store, "renderGraph", timelineValue("tv1", "size"));

    // Simulate a NumberControl scrub: intermediate live steps, then one commit at release.
    updateNodeParam(store, "renderGraph", "tv1", "value", 2, true);
    updateNodeParam(store, "renderGraph", "tv1", "value", 3, true);
    updateNodeParam(store, "renderGraph", "tv1", "value", 4, true);
    updateNodeParam(store, "renderGraph", "tv1", "value", 4);

    expect(paramValue(store, "tv1")).toBe(4);
    store.undo();
    // One step back to the value from before the whole gesture (1), not the 2 or 3 in between.
    expect(paramValue(store, "tv1")).toBe(1);
  });

  it("without live, every call records its own history entry (today's existing behavior)", () => {
    const store = freshStore();
    addNode(store, "renderGraph", timelineValue("tv1", "size"));

    updateNodeParam(store, "renderGraph", "tv1", "value", 2);
    updateNodeParam(store, "renderGraph", "tv1", "value", 3);

    expect(paramValue(store, "tv1")).toBe(3);
    store.undo();
    expect(paramValue(store, "tv1")).toBe(2);
    store.undo();
    expect(paramValue(store, "tv1")).toBe(1);
  });
});

/** Counts how many undo steps are available by draining and restoring the stack. */
function countUndoSteps(store: Store): number {
  let count = 0;
  while (store.canUndo) {
    store.undo();
    count++;
  }
  for (let i = 0; i < count; i++) {
    store.redo();
  }
  return count;
}
