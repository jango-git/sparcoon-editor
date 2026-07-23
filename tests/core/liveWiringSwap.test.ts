import { beforeEach, describe, expect, it } from "vitest";
import { FXGraphReconciler } from "../../src/engine/core/live/FXGraphReconciler";
import { FXLiveGraph } from "../../src/engine/core/live/FXLiveGraph";
import type { FXGraphSnapshotData } from "../../src/engine/core/live/FXSnapshotData";
import type { FakeNode } from "../helpers/fakeNodes";
import { FakeBackend, makeRegistry, socket } from "../helpers/fakeNodes";

// audit-4 L2 - the structural hash is content-addressed, so swapping the roles of two
// structurally identical nodes (values live in uniforms, outside the hash) leaves the
// hash, the id-set and the freshness all unchanged. Without an id-sensitive wiring
// fingerprint the gate rebinds and keeps the OLD wiring while the editor shows the new
// one - a value edit then drives the wrong output. These tests pin the swap to a
// recompile, and the calibration case proves the fingerprint does not over-trigger.

let backend: FakeBackend;
let live: FXLiveGraph<FakeNode>;

beforeEach(() => {
  const { registry } = makeRegistry([
    // Two instances of `src` are structurally identical (same type, no inputs) - the
    // exact blind spot of a content-addressed hash.
    { type: "src", outputs: [socket("out")] },
    { type: "sink", inputs: [socket("in1"), socket("in2")], outputs: [socket("out")] },
  ]);
  backend = new FakeBackend();
  live = new FXLiveGraph(new FXGraphReconciler(registry), backend);
});

describe("role swap of two identical output producers (audit-4 L2)", () => {
  const BOUND: FXGraphSnapshotData = {
    version: 2,
    nodes: { c1: { type: "src" }, c2: { type: "src" } },
    connections: [],
    outputBindings: [
      { slot: "albedo", from: { nodeId: "c1", socketKey: "out" } },
      { slot: "emissive", from: { nodeId: "c2", socketKey: "out" } },
    ],
  };
  const SWAPPED: FXGraphSnapshotData = {
    version: 2,
    nodes: { c1: { type: "src" }, c2: { type: "src" } },
    connections: [],
    outputBindings: [
      { slot: "albedo", from: { nodeId: "c2", socketKey: "out" } },
      { slot: "emissive", from: { nodeId: "c1", socketKey: "out" } },
    ],
  };

  it("recompiles the swap instead of rebinding into the stale wiring", () => {
    expect(live.apply(BOUND).status).toBe("recompiled");

    // Swapping which producer drives which slot is hash-invariant (same nodes, values
    // outside the hash), so only the wiring fingerprint can distinguish it.
    const compilesBefore = backend.compileCount;
    const result = live.apply(SWAPPED);
    expect(result.status).toBe("recompiled");
    expect(backend.compileCount).toBe(compilesBefore + 1);
  });

  it("does NOT recompile when the same wiring is re-applied (no false positive)", () => {
    expect(live.apply(BOUND).status).toBe("recompiled");
    const compilesBefore = backend.compileCount;
    // Identical wiring - a value-only editor snapshot. Must rebind, not recompile.
    expect(live.apply(BOUND).status).toBe("rebound");
    expect(backend.compileCount).toBe(compilesBefore);
  });
});

describe("role swap of two identical producers across one node's inputs (audit-4 L2)", () => {
  const FED: FXGraphSnapshotData = {
    version: 2,
    nodes: { p1: { type: "src" }, p2: { type: "src" }, n: { type: "sink" } },
    connections: [
      { from: { nodeId: "p1", socketKey: "out" }, to: { nodeId: "n", socketKey: "in1" } },
      { from: { nodeId: "p2", socketKey: "out" }, to: { nodeId: "n", socketKey: "in2" } },
    ],
    outputBindings: [{ slot: "albedo", from: { nodeId: "n", socketKey: "out" } }],
  };
  const FED_SWAPPED: FXGraphSnapshotData = {
    version: 2,
    nodes: { p1: { type: "src" }, p2: { type: "src" }, n: { type: "sink" } },
    connections: [
      { from: { nodeId: "p2", socketKey: "out" }, to: { nodeId: "n", socketKey: "in1" } },
      { from: { nodeId: "p1", socketKey: "out" }, to: { nodeId: "n", socketKey: "in2" } },
    ],
    outputBindings: [{ slot: "albedo", from: { nodeId: "n", socketKey: "out" } }],
  };

  it("recompiles when identical producers trade input sockets", () => {
    expect(live.apply(FED).status).toBe("recompiled");
    // n's merkle hash folds the producers' (identical) source hashes, so the swap is
    // hash-invariant; the fingerprint sees in1/in2 now carry different producer ids.
    const compilesBefore = backend.compileCount;
    const result = live.apply(FED_SWAPPED);
    expect(result.status).toBe("recompiled");
    expect(backend.compileCount).toBe(compilesBefore + 1);
  });
});
