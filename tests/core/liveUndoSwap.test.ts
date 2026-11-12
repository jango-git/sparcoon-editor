import { beforeEach, describe, expect, it } from "vitest";

import { FXGraphReconciler } from "../../src/engine/core/live/FXGraphReconciler";
import { FXLiveGraph } from "../../src/engine/core/live/FXLiveGraph";
import type { FXGraphSnapshotData } from "../../src/engine/core/live/FXSnapshotData";
import type { FakeNode } from "../helpers/fakeNodes";
import { FakeBackend, makeRegistry, socket } from "../helpers/fakeNodes";
import { CHAIN_PAIR, CHAIN_SINGLE } from "../helpers/liveSnapshots";

// The rebind gate must see *instance* freshness, not just the
// id-set: deleting a node during an invalid stretch and then undoing restores the
// same id and the same structural hash, but the reconciler re-mints the instance.
// A rebind would push values into handles the installed artifact never created and
// free the old instance while the artifact still references it.

/** CHAIN_PAIR with `b` re-typed to `other` - transiently applied while invalid. */
const B_RETYPED: FXGraphSnapshotData = {
  version: 2,
  nodes: { a: { type: "chain" }, b: { type: "other" } },
  connections: [{ from: { nodeId: "b", socketKey: "out" }, to: { nodeId: "a", socketKey: "in" } }],
  outputBindings: [{ slot: "albedo", from: { nodeId: "a", socketKey: "out" } }],
};

let backend: FakeBackend;
let live: FXLiveGraph<FakeNode>;
let created: FakeNode[];

/** The instance currently registered under `b` (last minted `chain`/`other` for it). */
function instanceOf(type: string, nth: number): FakeNode {
  const all = created.filter((node) => node.type === type);
  const node = all[nth];
  // A real out-of-bounds check, not a noUncheckedIndexedAccess artifact - the tests
  // tsconfig relaxes that flag, but `all[nth]` can genuinely be undefined here.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (node === undefined) {
    throw new Error(`no instance #${String(nth)} of type "${type}"`);
  }
  return node;
}

beforeEach(() => {
  const result = makeRegistry([
    { type: "chain", inputs: [socket("in")], outputs: [socket("out")] },
    { type: "other", inputs: [socket("in")], outputs: [socket("out")] },
  ]);
  created = result.created;
  backend = new FakeBackend();
  live = new FXLiveGraph(new FXGraphReconciler(result.registry), backend);
});

describe("undo across an invalid stretch (same-id instance swap)", () => {
  it("delete -> invalid -> undo (same id) recompiles instead of stale-rebinding", () => {
    expect(live.apply(CHAIN_PAIR).status).toBe("recompiled");
    // created[0] = a, created[1] = b0 (object-key order of CHAIN_PAIR.nodes).
    const b0 = instanceOf("chain", 1);

    // The editor deletes `b`; the graph is transiently invalid -> artifact held,
    // b0 deferred (the installed artifact still references it).
    backend.forceInvalid = true;
    expect(live.apply(CHAIN_SINGLE).status).toBe("invalid");
    expect(b0.destroyCount).toBe(0);

    // Undo: the same snapshot shape returns under the same id `b`. The hash and the
    // id-set both match the installed artifact, but the instance is freshly minted.
    backend.forceInvalid = false;
    const compilesBefore = backend.compileCount;
    const result = live.apply(CHAIN_PAIR);
    expect(result.status).toBe("recompiled");
    expect(backend.compileCount).toBe(compilesBefore + 1);

    // b0 was destroyed exactly once, and only now (after the new artifact install).
    expect(b0.destroyCount).toBe(1);

    // Value edits on `b` are live again: a rebound apply syncs the *new* instance.
    const b1 = instanceOf("chain", 2);
    expect(b1).not.toBe(b0);
    const syncsBefore = b1.syncCount;
    expect(live.apply(CHAIN_PAIR).status).toBe("rebound");
    expect(b1.syncCount).toBe(syncsBefore + 1);
    expect(b0.destroyCount).toBe(1);
  });

  it("type flip chain->other->chain across an invalid stretch recompiles", () => {
    expect(live.apply(CHAIN_PAIR).status).toBe("recompiled");
    const b0 = instanceOf("chain", 1);

    // Re-type `b` while the graph is transiently invalid: b0 is replaced/discarded.
    backend.forceInvalid = true;
    expect(live.apply(B_RETYPED).status).toBe("invalid");
    expect(b0.destroyCount).toBe(0);

    // Back to `chain` under the same id: hash and id-set match the installed
    // artifact, but `b` is now a third instance that was never built.
    backend.forceInvalid = false;
    const result = live.apply(CHAIN_PAIR);
    expect(result.status).toBe("recompiled");
    expect(b0.destroyCount).toBe(1);
    expect(instanceOf("other", 0).destroyCount).toBe(1);
  });
});

describe("undo after a compile that threw mid-build (poisoned gate)", () => {
  // CHAIN_PAIR plus a second output binding on `b`: same two instances, but a different
  // structural hash. The extra slot is what lets `b.out` reach compilation while `a`
  // and `b` stay resident (no add / remove / re-type -> nothing re-minted).
  const WITH_EXTRA_BINDING: FXGraphSnapshotData = {
    version: 2,
    nodes: { a: { type: "chain" }, b: { type: "chain" } },
    connections: [
      { from: { nodeId: "b", socketKey: "out" }, to: { nodeId: "a", socketKey: "in" } },
    ],
    outputBindings: [
      { slot: "albedo", from: { nodeId: "a", socketKey: "out" } },
      { slot: "emissive", from: { nodeId: "b", socketKey: "out" } },
    ],
  };

  it("forces the undo to recompile instead of rebinding into orphaned handles", () => {
    expect(live.apply(CHAIN_PAIR).status).toBe("recompiled");
    const a0 = instanceOf("chain", 0);
    const b0 = instanceOf("chain", 1);

    // A valid structural edit whose compile throws part-way through `build`: the last
    // good artifact is held, but every instance built before the throw now carries
    // handles into the aborted compile context.
    // The throw never escapes apply: it comes back as a held `compile-failed`.
    const held = live.artifact;
    backend.compileThrows = true;
    let failed: ReturnType<typeof live.apply> | undefined;
    expect(() => {
      failed = live.apply(WITH_EXTRA_BINDING);
    }).not.toThrow();
    expect(failed?.status).toBe("invalid");
    expect(failed?.errors[0]?.code).toBe("compile-failed");
    expect(failed?.errors[0]?.message).toContain("compile boom");
    expect(live.artifact).toBe(held);

    // Undo to the installed structure. Nothing was added, removed or re-typed, so the
    // instances are identical, the id-set matches and no id is fresh - the instance
    // freshness guard cannot fire here. Without poisoning `currentHash`, the hash
    // would still match and this would rebind into the orphaned handles. It must
    // recompile and re-mint them instead.
    backend.compileThrows = false;
    const compilesBefore = backend.compileCount;
    const result = live.apply(CHAIN_PAIR);
    expect(result.status).toBe("recompiled");
    expect(backend.compileCount).toBe(compilesBefore + 1);

    // The instances never changed - this is precisely why the freshness guard missed
    // it, and why re-minting handles via recompile is the only remedy.
    expect(instanceOf("chain", 0)).toBe(a0);
    expect(instanceOf("chain", 1)).toBe(b0);

    // Value edits land again: the following rebind syncs the freshly re-minted handles.
    const syncsBefore = b0.syncCount;
    expect(live.apply(CHAIN_PAIR).status).toBe("rebound");
    expect(b0.syncCount).toBe(syncsBefore + 1);
  });
});
