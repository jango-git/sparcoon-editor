import type { FXEmitter } from "sparcoon/editor";
import { afterEach, describe, expect, it } from "vitest";

import { RENDER_SINK_ID, RENDER_SORT_INTERVAL_PARAM } from "../../src/domain/nodePalette";
import { updateNodeParam } from "../../src/model/commands";
import { emitterEntity } from "../../src/model/entity";
import { Store } from "../../src/model/store";
import { createPreview, destroyPreviews } from "../helpers/previewScene";
import { createTestState } from "../helpers/testDocument";

afterEach(() => {
  destroyPreviews();
});

describe("depth sort: live preview", () => {
  it("rebuilds the emitter to turn sorting on or off, and changes its interval in place", () => {
    const store = new Store(createTestState());
    const emitters = createPreview();
    const id = store.getSource().scene.emitters[0].id;
    const emitter = (): FXEmitter => emitters.entityObject(emitterEntity(id)) as FXEmitter;
    const sortEvery = (frames: number): void => {
      updateNodeParam(store, "renderGraph", RENDER_SINK_ID, RENDER_SORT_INTERVAL_PARAM, frames);
      emitters.sync(store.getSource().scene);
    };

    emitters.sync(store.getSource().scene);
    const unsorted = emitter();
    expect(unsorted.sort).toBeUndefined();

    sortEvery(4);
    const sorted = emitter();
    expect(sorted).not.toBe(unsorted);
    expect(sorted.sort?.fraction).toBe(0.25);

    sortEvery(2);
    expect(emitter()).toBe(sorted);
    expect(sorted.sort?.fraction).toBe(0.5);

    sortEvery(0);
    expect(emitter()).not.toBe(sorted);
    expect(emitter().sort).toBeUndefined();
  });
});
