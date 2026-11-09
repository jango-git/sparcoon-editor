import { beforeEach, describe, expect, it } from "vitest";
import { FXGraphReconciler } from "../../src/engine/core/live/FXGraphReconciler";
import { FXLiveGraph } from "../../src/engine/core/live/FXLiveGraph";
import type { FakeNode } from "../helpers/fakeNodes";
import { FakeBackend, makeRegistry, socket } from "../helpers/fakeNodes";
import { CHAIN_PAIR, CHAIN_SINGLE, chainSnapshot } from "../helpers/liveSnapshots";

/** CHAIN_PAIR plus an unreachable `island` node - same hash (island never compiles). */
const WITH_ISLAND = chainSnapshot({ a: "chain", b: "chain", island: "chain" }, [["b", "a"]], "a");

/** Structurally identical to CHAIN_PAIR but `b` renamed to `b2` - an id-swap. */
const SWAPPED = chainSnapshot({ a: "chain", b2: "chain" }, [["b2", "a"]], "a");

/** `c1` feeds `a`; `c2` is present but unreachable (a resident spare). */
const RESIDENT_SPARE = chainSnapshot({ a: "chain", c1: "chain", c2: "chain" }, [["c1", "a"]], "a");

/** `c1` deleted, its slot re-wired to the (structurally identical) resident `c2`. */
const RESIDENT_SWAP = chainSnapshot({ a: "chain", c2: "chain" }, [["c2", "a"]], "a");

let backend: FakeBackend;
let live: FXLiveGraph<FakeNode>;

/** The live instance currently resident under `id`. */
function nodeAt(id: string): FakeNode {
  const node = live.graphView.getNode(id);
  if (node === undefined) {
    throw new Error(`no resident node "${id}"`);
  }
  return node;
}

beforeEach(() => {
  const registry = makeRegistry([
    { type: "chain", inputs: [socket("in")], outputs: [socket("out")] },
  ]);
  backend = new FakeBackend();
  live = new FXLiveGraph(new FXGraphReconciler(registry.registry), backend);
});

describe("FXLiveGraph.apply", () => {
  it("recompiles and installs on the first valid apply", () => {
    const result = live.apply(CHAIN_PAIR);

    expect(result.status).toBe("recompiled");
    expect(backend.compileCount).toBe(1);
    expect(backend.installCount).toBe(1);
    expect(live.artifact).toBeDefined();
  });

  it("rebinds on an identical re-apply, pushing live values without a compile", () => {
    live.apply(CHAIN_PAIR);
    const result = live.apply(CHAIN_PAIR);

    expect(result.status).toBe("rebound");
    expect(backend.compileCount).toBe(1);
    // syncLiveValues fired once on every reachable node (the recompile itself syncs nothing).
    expect(nodeAt("a").syncCount).toBe(1);
    expect(nodeAt("b").syncCount).toBe(1);
  });

  it("holds the last good artifact and skips compile while invalid", () => {
    live.apply(CHAIN_PAIR);
    const held = live.artifact;

    backend.forceInvalid = true;
    const result = live.apply(CHAIN_PAIR);

    expect(result.status).toBe("invalid");
    expect(backend.compileCount).toBe(1);
    expect(live.artifact).toBe(held);
  });

  it("recovers with a rebind after an invalid edit, without recompiling", () => {
    live.apply(CHAIN_PAIR);
    backend.forceInvalid = true;
    live.apply(CHAIN_PAIR);

    backend.forceInvalid = false;
    const result = live.apply(CHAIN_PAIR);

    expect(result.status).toBe("rebound");
    expect(backend.compileCount).toBe(1);
  });

  it("defers destroy of a node removed during invalid until the next recompile", () => {
    live.apply(CHAIN_PAIR);
    const b = nodeAt("b");

    backend.forceInvalid = true;
    live.apply(CHAIN_SINGLE);
    expect(b.destroyCount).toBe(0);

    backend.forceInvalid = false;
    const result = live.apply(CHAIN_SINGLE);
    expect(result.status).toBe("recompiled");
    expect(b.destroyCount).toBe(1);
  });

  it("flushes a deferred discard immediately on rebound (unchanged hash)", () => {
    live.apply(WITH_ISLAND);
    const island = nodeAt("island");
    expect(island.destroyCount).toBe(0);

    // Removing the unreachable island does not change the hash -> rebound. Its
    // destroy must fire now, not wait for some future recompile.
    const result = live.apply(CHAIN_PAIR);
    expect(result.status).toBe("rebound");
    expect(island.destroyCount).toBe(1);
  });

  it("recompiles on an id-swap even though the structural hash is unchanged", () => {
    live.apply(CHAIN_PAIR);
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
    const c1 = nodeAt("c1");
    expect(c1.destroyCount).toBe(0);

    // Deleting the reachable c1 and re-wiring to the structurally identical resident
    // c2 leaves the hash unchanged and adds no *fresh* node - a fresh-id guard alone
    // would rebind (c2 never built, c1 freed under a live artifact). The reachable-set
    // guard forces a recompile.
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
    live.apply(CHAIN_PAIR);
    const a = nodeAt("a");
    const b = nodeAt("b");

    backend.forceInvalid = true;
    live.apply(CHAIN_SINGLE); // b becomes a pending discard, not yet destroyed
    expect(b.destroyCount).toBe(0);

    live.destroy();

    expect(b.destroyCount).toBe(1); // pending flushed
    expect(a.destroyCount).toBe(1); // resident destroyed
  });

  it("destroy is idempotent and apply after destroy is a structural `disposed`", () => {
    live.apply(CHAIN_PAIR);
    const a = nodeAt("a");
    const b = nodeAt("b");
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
    const paramsBefore = a.applyParamsCount;
    const result = live.apply(CHAIN_PAIR);
    expect(result.status).toBe("invalid");
    expect(result.errors[0]?.code).toBe("disposed");
    expect(backend.compileCount).toBe(compilesBefore);
    expect(a.applyParamsCount).toBe(paramsBefore);
    expect(b.syncCount).toBe(0);
  });
});

describe("FXLiveGraph host failures and teardown", () => {
  it("codes a throw inside previewHash as hash-failed, not validate-failed", () => {
    backend.previewHashThrows = true;
    const result = live.apply(CHAIN_PAIR);
    expect(result.status).toBe("invalid");
    expect(result.errors[0]?.code).toBe("hash-failed");
  });

  it("destroy releases the installed artifact", () => {
    live.apply(CHAIN_PAIR);
    expect(live.artifact).toBeDefined();
    live.destroy();
    expect(live.artifact).toBeUndefined();
  });
});

describe("FXGraphReconciler prepare retry", () => {
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
    const first = live2.apply(CHAIN_PAIR);
    expect(first.status).toBe("invalid");
    const [a] = registry.created;
    expect(a.prepareCount).toBe(1);

    // Prepare now succeeds: the next reconcile must retry it (not skip the resident,
    // still-unprepared node forever) and reach a clean recompile.
    throwPrepare = false;
    const second = live2.apply(CHAIN_PAIR);
    expect(second.status).toBe("recompiled");
    expect(a.prepareCount).toBe(2);
  });
});
