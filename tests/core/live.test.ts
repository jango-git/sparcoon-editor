import { beforeEach, describe, expect, it } from "vitest";
import { FXGraphReconciler } from "../../src/engine/core/live/FXGraphReconciler";
import { FXLiveGraph } from "../../src/engine/core/live/FXLiveGraph";
import type { FXGraphSnapshotData } from "../../src/engine/core/live/FXSnapshotData";
import type { FakeNode } from "../helpers/fakeNodes";
import { FakeBackend, makeRegistry, socket } from "../helpers/fakeNodes";

/** Full graph: b.out -> a.in, albedo <- a.out (both nodes reachable). */
const FULL: FXGraphSnapshotData = {
  version: 2,
  nodes: { a: { type: "chain" }, b: { type: "chain" } },
  connections: [{ from: { nodeId: "b", socketKey: "out" }, to: { nodeId: "a", socketKey: "in" } }],
  outputBindings: [{ slot: "albedo", from: { nodeId: "a", socketKey: "out" } }],
};

/** Same as FULL but node `b` removed - a structural change. */
const REDUCED: FXGraphSnapshotData = {
  version: 2,
  nodes: { a: { type: "chain" } },
  connections: [],
  outputBindings: [{ slot: "albedo", from: { nodeId: "a", socketKey: "out" } }],
};

/** FULL plus an unreachable `island` node - same hash (island never compiles). */
const WITH_ISLAND: FXGraphSnapshotData = {
  version: 2,
  nodes: { a: { type: "chain" }, b: { type: "chain" }, island: { type: "chain" } },
  connections: [{ from: { nodeId: "b", socketKey: "out" }, to: { nodeId: "a", socketKey: "in" } }],
  outputBindings: [{ slot: "albedo", from: { nodeId: "a", socketKey: "out" } }],
};

/** Structurally identical to FULL but `b` renamed to `b2` - an id-swap. */
const SWAPPED: FXGraphSnapshotData = {
  version: 2,
  nodes: { a: { type: "chain" }, b2: { type: "chain" } },
  connections: [{ from: { nodeId: "b2", socketKey: "out" }, to: { nodeId: "a", socketKey: "in" } }],
  outputBindings: [{ slot: "albedo", from: { nodeId: "a", socketKey: "out" } }],
};

/** `c1` feeds `a`; `c2` is present but unreachable (a resident spare). */
const RESIDENT_SPARE: FXGraphSnapshotData = {
  version: 2,
  nodes: { a: { type: "chain" }, c1: { type: "chain" }, c2: { type: "chain" } },
  connections: [{ from: { nodeId: "c1", socketKey: "out" }, to: { nodeId: "a", socketKey: "in" } }],
  outputBindings: [{ slot: "albedo", from: { nodeId: "a", socketKey: "out" } }],
};

/** `c1` deleted, its slot re-wired to the (structurally identical) resident `c2`. */
const RESIDENT_SWAP: FXGraphSnapshotData = {
  version: 2,
  nodes: { a: { type: "chain" }, c2: { type: "chain" } },
  connections: [{ from: { nodeId: "c2", socketKey: "out" }, to: { nodeId: "a", socketKey: "in" } }],
  outputBindings: [{ slot: "albedo", from: { nodeId: "a", socketKey: "out" } }],
};

let backend: FakeBackend;
let live: FXLiveGraph<FakeNode>;
let created: FakeNode[];

beforeEach(() => {
  const registry = makeRegistry([
    { type: "chain", inputs: [socket("in")], outputs: [socket("out")] },
  ]);
  created = registry.created;
  backend = new FakeBackend();
  live = new FXLiveGraph(new FXGraphReconciler(registry.registry), backend);
});

describe("FXLiveGraph.apply", () => {
  it("recompiles and installs on the first valid apply", () => {
    const result = live.apply(FULL);

    expect(result.status).toBe("recompiled");
    expect(backend.compileCount).toBe(1);
    expect(backend.installCount).toBe(1);
    expect(live.artifact).toBeDefined();
  });

  it("rebinds on an identical re-apply, pushing live values without a compile", () => {
    live.apply(FULL);
    const result = live.apply(FULL);

    expect(result.status).toBe("rebound");
    expect(backend.compileCount).toBe(1);
    // syncLiveValues fired on every reachable node.
    expect(created[0].syncCount).toBeGreaterThan(0);
    expect(created[1].syncCount).toBeGreaterThan(0);
  });

  it("holds the last good artifact and skips compile while invalid", () => {
    live.apply(FULL);
    const held = live.artifact;

    backend.forceInvalid = true;
    const result = live.apply(FULL);

    expect(result.status).toBe("invalid");
    expect(backend.compileCount).toBe(1);
    expect(live.artifact).toBe(held);
  });

  it("recovers with a rebind after an invalid edit, without recompiling", () => {
    live.apply(FULL);
    backend.forceInvalid = true;
    live.apply(FULL);

    backend.forceInvalid = false;
    const result = live.apply(FULL);

    expect(result.status).toBe("rebound");
    expect(backend.compileCount).toBe(1);
  });

  it("defers destroy of a node removed during invalid until the next recompile", () => {
    live.apply(FULL);
    const b = created[1];

    backend.forceInvalid = true;
    live.apply(REDUCED);
    expect(b.destroyCount).toBe(0);

    backend.forceInvalid = false;
    const result = live.apply(REDUCED);
    expect(result.status).toBe("recompiled");
    expect(b.destroyCount).toBe(1);
  });

  it("flushes a deferred discard immediately on rebound (unchanged hash)", () => {
    live.apply(WITH_ISLAND);
    const island = created[2]; // keys a, b, island -> third created instance
    expect(island.destroyCount).toBe(0);

    // Removing the unreachable island does not change the hash -> rebound. Its
    // destroy must fire now, not wait for some future recompile.
    const result = live.apply(FULL);
    expect(result.status).toBe("rebound");
    expect(island.destroyCount).toBe(1);
  });

  it("recompiles on an id-swap even though the structural hash is unchanged", () => {
    live.apply(FULL);
    expect(backend.compileCount).toBe(1);

    // b -> b2 is structurally identical: b2 is a fresh reachable instance, so the
    // hash-equal path must NOT rebind (its handles were never built).
    const swap = live.apply(SWAPPED);
    expect(swap.status).toBe("recompiled");
    expect(backend.compileCount).toBe(2);

    // Re-applying the same snapshot now finds b2 resident (reachable set unchanged);
    // this rebinds, which proves SWAPPED's hash equals the installed one - so the
    // recompile above was driven solely by the reachable-set (id-swap) guard.
    const settle = live.apply(SWAPPED);
    expect(settle.status).toBe("rebound");
    expect(backend.compileCount).toBe(2);
  });

  it("recompiles on a resident-swap (reachable set changed, hash unchanged)", () => {
    live.apply(RESIDENT_SPARE);
    expect(backend.compileCount).toBe(1);
    const c1 = created[1]; // keys a, c1, c2 -> second created instance
    expect(c1.destroyCount).toBe(0);

    // Deleting the reachable c1 and re-wiring to the structurally identical resident
    // c2 leaves the hash unchanged and adds no *fresh* node - the old fresh-id guard
    // would have wrongly rebound (c2 never built, c1 freed under a live artifact).
    // The reachable-set guard forces a recompile.
    const swap = live.apply(RESIDENT_SWAP);
    expect(swap.status).toBe("recompiled");
    expect(backend.compileCount).toBe(2);
    // c1 is freed only now - after the new artifact (built over c2) was installed.
    expect(backend.installCount).toBe(2);
    expect(c1.destroyCount).toBe(1);

    // The recompile refreshed the installed reachable set to {a, c2}; replay rebinds.
    const settle = live.apply(RESIDENT_SWAP);
    expect(settle.status).toBe("rebound");
    expect(backend.compileCount).toBe(2);
  });

  it("flushes pending destroys and destroys resident nodes on teardown", () => {
    live.apply(FULL);
    const [a, b] = created;

    backend.forceInvalid = true;
    live.apply(REDUCED); // b becomes a pending discard, not yet destroyed
    expect(b.destroyCount).toBe(0);

    live.destroy();

    expect(b.destroyCount).toBe(1); // pending flushed
    expect(a.destroyCount).toBe(1); // resident destroyed
  });

  it("destroy is idempotent and apply after destroy is a structural `disposed` (P11.5, L7)", () => {
    live.apply(FULL);
    const [a, b] = created;
    live.destroy();
    expect(a.destroyCount).toBe(1);
    expect(b.destroyCount).toBe(1);

    // Double destroy: no re-destroy, no throw.
    expect(() => live.destroy()).not.toThrow();
    expect(a.destroyCount).toBe(1);
    expect(b.destroyCount).toBe(1);

    // A late snapshot (a natural editor race) is refused structurally: no
    // reconcile, no compile, no rebinding into destroyed handles.
    const compilesBefore = backend.compileCount;
    const result = live.apply(FULL);
    expect(result.status).toBe("invalid");
    expect(result.errors[0]?.code).toBe("disposed");
    expect(backend.compileCount).toBe(compilesBefore);
    expect(a.applyParamsCount).toBeLessThanOrEqual(2);
  });
});

describe("FXLiveGraph - Block B fixes (audit-4 L8/L9)", () => {
  it("L8: a throw inside previewHash is coded hash-failed, not validate-failed", () => {
    backend.previewHashThrows = true;
    const result = live.apply(FULL);
    expect(result.status).toBe("invalid");
    expect(result.errors[0]?.code).toBe("hash-failed");
  });

  it("L9: destroy releases the installed artifact", () => {
    live.apply(FULL);
    expect(live.artifact).toBeDefined();
    live.destroy();
    expect(live.artifact).toBeUndefined();
  });
});

describe("FXGraphReconciler - prepare retry (audit-4 L6)", () => {
  it("retries prepare() on the next reconcile after it threw once", () => {
    let throwPrepare = true;
    const registry = makeRegistry([
      {
        type: "chain",
        inputs: [socket("in")],
        outputs: [socket("out")],
        prepareThrows: () => throwPrepare,
      },
    ]);
    const live2 = new FXLiveGraph<FakeNode>(
      new FXGraphReconciler(registry.registry),
      new FakeBackend(),
    );

    // First apply: prepare throws -> the node stays resident but unprepared -> invalid.
    const first = live2.apply(FULL);
    expect(first.status).toBe("invalid");
    const [a] = registry.created;
    expect(a.prepareCount).toBe(1);

    // Prepare now succeeds: the next reconcile must retry it (not skip the resident,
    // still-unprepared node forever) and reach a clean recompile.
    throwPrepare = false;
    const second = live2.apply(FULL);
    expect(second.status).toBe("recompiled");
    expect(a.prepareCount).toBe(2);
  });
});
