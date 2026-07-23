import { describe, expect, it, vi } from "vitest";
import { createInitialState } from "../../src/model/editorState";
import { Store } from "../../src/model/store";
import { SignalBus } from "../../src/model/signals";
import { Pipeline, type SceneApplier, type SceneApplyResult } from "../../src/model/pipeline";

function result(recompiled: boolean): SceneApplyResult {
  const empty = {} as never;
  return {
    renderSnapshot: empty,
    behaviorSnapshot: empty,
    renderStatus: { status: "rebound", messages: [] },
    behaviorStatus: { status: "rebound", messages: [] },
    recompiled,
  };
}

describe("Pipeline: restart only on a real rebuild", () => {
  it("fires onRecompiled when the sync rebuilt, but not when it only rebound", () => {
    const store = new Store(createInitialState(), new SignalBus());
    const onRecompiled = vi.fn();
    let recompiled = true;
    const applier: SceneApplier = { sync: () => result(recompiled) };
    const pipeline = new Pipeline(store, applier, onRecompiled);

    pipeline.recomputeNow();
    expect(onRecompiled).toHaveBeenCalledTimes(1);

    // A value-only rebind (e.g. editing a timeline-value) must not restart the timeline.
    recompiled = false;
    pipeline.recomputeNow();
    expect(onRecompiled).toHaveBeenCalledTimes(1);
  });
});
