import { describe, expect, it } from "vitest";
import { gpuSortWarnings } from "../../src/domain/sortChecks";
import { RENDER_SINK_ID } from "../../src/domain/sinkMeta";

describe("gpuSortWarnings", () => {
  it("warns, on the render sink, when a GPU-simulated emitter asks for a depth sort", () => {
    expect(gpuSortWarnings(2, true)).toMatchObject([
      { code: "sort-on-gpu-emitter", nodeId: RENDER_SINK_ID },
    ]);
  });

  it("is quiet without a sort, or on the CPU", () => {
    expect(gpuSortWarnings(0, true)).toEqual([]);
    expect(gpuSortWarnings(3, false)).toEqual([]);
  });
});
