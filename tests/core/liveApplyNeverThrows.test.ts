import { beforeEach, describe, expect, it } from "vitest";
import type { FXCompilerErrorCode } from "../../src/engine/core/compiler/FXCompilerError";
import { FXGraphReconciler } from "../../src/engine/core/live/FXGraphReconciler";
import { FXLiveGraph } from "../../src/engine/core/live/FXLiveGraph";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import type { FXGraphSnapshotData } from "../../src/engine/core/live/FXSnapshotData";
import { assertValidAttributeName } from "../../src/engine/core/socket/FXAttribute";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FXRenderLiveBackend } from "../../src/engine/render/live/FXRenderLiveBackend";
import { buildParticleTarget } from "../../src/engine/render/target/FXParticleRenderTarget";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { FXBehaviorLiveBackend } from "../../src/engine/behavior/live/FXBehaviorLiveBackend";
import type { FXBehaviorTargets } from "../../src/engine/behavior/FXParticleBehaviorTarget";
import {
  registerStandardBehaviorNodes,
  registerStandardRenderNodes,
} from "../../src/engine/nodes-std/index";
import { FakeBackend, FakeNode, socket } from "../helpers/fakeNodes";

// P6.4 - no input to `FXLiveGraph.apply` may crash the editor. Each of the four
// throw-classes reconcile can raise (unknown node type, unmigratable snapshot
// version, a bad param of an existing node, a malformed attribute name) must come
// back as a structured `invalid` with a code (and `nodeId` where it applies), the
// last good artifact must survive, and the very next valid snapshot must fully
// restore the graph via `recompiled`.

/** Registry with a plain `chain` node and an `attribute` node that validates its name. */
function makeRegistry(): { registry: FXNodeRegistry<FakeNode>; created: FakeNode[] } {
  const registry = new FXNodeRegistry<FakeNode>();
  const created: FakeNode[] = [];
  registry.register("chain", () => {
    const node = new FakeNode({ type: "chain", inputs: [socket("in")], outputs: [socket("out")] });
    created.push(node);
    return node;
  });
  registry.register("attribute", (params) => {
    // Mirrors the real store/custom-attribute factories: the name is validated at the
    // source, so a malformed one throws a typed `bad-attribute-name` on create.
    assertValidAttributeName(String(params?.["name"] ?? ""), "store-attribute.name");
    const node = new FakeNode({ type: "attribute", outputs: [socket("out")] });
    created.push(node);
    return node;
  });
  return { registry, created };
}

/** A valid single-node graph that installs an artifact. */
const VALID: FXGraphSnapshotData = {
  version: 2,
  nodes: { a: { type: "chain" } },
  connections: [],
  outputBindings: [{ slot: "albedo", from: { nodeId: "a", socketKey: "out" } }],
};

let backend: FakeBackend;
let live: FXLiveGraph<FakeNode>;

beforeEach(() => {
  const { registry } = makeRegistry();
  backend = new FakeBackend();
  live = new FXLiveGraph(new FXGraphReconciler(registry), backend);
  // Install a good artifact first, so every malformed case must *hold* it.
  expect(live.apply(VALID).status).toBe("recompiled");
});

/** Asserts a malformed snapshot yields a held `invalid` without throwing. */
function expectHeldInvalid(
  data: FXGraphSnapshotData,
  code: FXCompilerErrorCode,
  nodeId?: string,
): void {
  const heldArtifact = live.artifact;
  const compilesBefore = backend.compileCount;

  let result: ReturnType<typeof live.apply> | undefined;
  expect(() => {
    result = live.apply(data);
  }).not.toThrow();

  expect(result?.status).toBe("invalid");
  expect(result?.errors).toHaveLength(1);
  expect(result?.errors[0]?.code).toBe(code);
  if (nodeId !== undefined) {
    expect(result?.errors[0]?.nodeId).toBe(nodeId);
  }
  // The last good artifact is untouched - no compile ran, nothing was hot-swapped.
  expect(live.artifact).toBe(heldArtifact);
  expect(backend.compileCount).toBe(compilesBefore);
}

describe("FXLiveGraph.apply never throws (P6)", () => {
  it("unknown node type -> invalid `unknown-node-type` with nodeId, artifact held", () => {
    expectHeldInvalid(
      {
        version: 2,
        nodes: { a: { type: "chain" }, x: { type: "no-such-node" } },
        connections: [],
        outputBindings: [{ slot: "albedo", from: { nodeId: "a", socketKey: "out" } }],
      },
      "unknown-node-type",
      "x",
    );
  });

  it("unmigratable snapshot version -> invalid `unsupported-snapshot-version`", () => {
    expectHeldInvalid(
      { ...VALID, version: 99 } as FXGraphSnapshotData,
      "unsupported-snapshot-version",
    );
  });

  it("bad param of an existing node -> invalid `bad-param` with nodeId", () => {
    expectHeldInvalid(
      {
        version: 2,
        nodes: {
          a: {
            type: "chain",
            params: { forcedThrowMessage: "chain.value expects a finite number" },
          },
        },
        connections: [],
        outputBindings: [{ slot: "albedo", from: { nodeId: "a", socketKey: "out" } }],
      },
      "bad-param",
      "a",
    );
  });

  it("malformed attribute name -> invalid `bad-attribute-name` with nodeId", () => {
    expectHeldInvalid(
      {
        version: 2,
        nodes: {
          a: { type: "chain" },
          bad: { type: "attribute", params: { name: "not a name" } },
        },
        connections: [],
        outputBindings: [{ slot: "albedo", from: { nodeId: "a", socketKey: "out" } }],
      },
      "bad-attribute-name",
      "bad",
    );
  });

  it("real descriptor coerce rejection (NaN) -> invalid `bad-finite-vector`, no throw", () => {
    // End-to-end proof against the actual `coerce`, not the FakeNode sentinel: a real
    // `constant` (color type) whose vec4 `value` has a NaN component throws `bad-finite-vector`
    // from `finiteVector` (paramValidators.Internal.ts) inside `applyParams`, and that surfaces
    // as a held, already-typed error through the real render live backend (FXGraphReconciler's
    // catch-all preserves a caught FXCompilerErrorException's own code, only tagging nodeId).
    const registry = new FXNodeRegistry<FXRenderNode>();
    registerStandardRenderNodes(registry);
    const renderLive = new FXLiveGraph(
      new FXGraphReconciler(registry),
      new FXRenderLiveBackend(
        "baseline",
        (attributes) => buildParticleTarget(attributes),
        () => {
          /* install sink */
        },
      ),
    );

    const good: FXGraphSnapshotData = {
      version: 2,
      nodes: { e: { type: "constant", params: { type: "color", value: [1, 1, 1, 1] } } },
      connections: [],
      outputBindings: [{ slot: "albedo", from: { nodeId: "e", socketKey: "out" } }],
    };
    expect(renderLive.apply(good).status).toBe("recompiled");
    const held = renderLive.artifact;

    let result: ReturnType<typeof renderLive.apply> | undefined;
    expect(() => {
      result = renderLive.apply({
        ...good,
        nodes: { e: { type: "constant", params: { type: "color", value: [Number.NaN, 1, 1, 1] } } },
      });
    }).not.toThrow();
    expect(result?.status).toBe("invalid");
    expect(result?.errors[0]?.code).toBe("bad-finite-vector");
    expect(result?.errors[0]?.nodeId).toBe("e");
    expect(renderLive.artifact).toBe(held);

    // Recovery: re-applying the identical good snapshot is a rebind (hash unchanged), and
    // a different color value recompiles (a constant bakes its value inline, variant A).
    expect(renderLive.apply(good).status).toBe("rebound");
    expect(
      renderLive.apply({
        ...good,
        nodes: { e: { type: "constant", params: { type: "color", value: [0.5, 0.5, 0.5, 1] } } },
      }).status,
    ).toBe("recompiled");
  });

  it("throwing buildTarget factory -> invalid `validate-failed`, no throw (P11.2)", () => {
    const registry = new FXNodeRegistry<FXRenderNode>();
    registerStandardRenderNodes(registry);
    const renderLive = new FXLiveGraph(
      new FXGraphReconciler(registry),
      new FXRenderLiveBackend(
        "baseline",
        () => {
          throw new Error("host target factory boom");
        },
        () => {
          /* install sink */
        },
      ),
    );

    let result: ReturnType<typeof renderLive.apply> | undefined;
    expect(() => {
      result = renderLive.apply({
        version: 2,
        nodes: { e: { type: "constant", params: { type: "color" } } },
        connections: [],
        outputBindings: [{ slot: "albedo", from: { nodeId: "e", socketKey: "out" } }],
      });
    }).not.toThrow();
    expect(result?.status).toBe("invalid");
    expect(result?.errors[0]?.code).toBe("validate-failed");
    expect(result?.errors[0]?.message).toContain("boom");
  });

  it("structurally malformed render target literal -> invalid `malformed-target-shape`, no throw (P11.2)", () => {
    const registry = new FXNodeRegistry<FXRenderNode>();
    registerStandardRenderNodes(registry);
    // A hand-authored host target literal with no `inputs` and a junk output type.
    const junkTarget = { name: "junk", outputs: [{ slot: 5 }] } as unknown as ReturnType<
      typeof buildParticleTarget
    >;
    const renderLive = new FXLiveGraph(
      new FXGraphReconciler(registry),
      new FXRenderLiveBackend(
        "baseline",
        () => junkTarget,
        () => {
          /* install sink */
        },
      ),
    );

    let result: ReturnType<typeof renderLive.apply> | undefined;
    expect(() => {
      result = renderLive.apply({
        version: 2,
        nodes: { e: { type: "constant", params: { type: "color" } } },
        connections: [],
        outputBindings: [{ slot: "albedo", from: { nodeId: "e", socketKey: "out" } }],
      });
    }).not.toThrow();
    expect(result?.status).toBe("invalid");
    expect(result?.errors.length).toBeGreaterThan(0);
    for (const error of result?.errors ?? []) {
      expect(error.code).toBe("malformed-target-shape");
    }
    expect(result?.errors.some((error) => error.message.includes("inputs"))).toBe(true);
  });

  it("structurally malformed kernel target literal -> invalid `malformed-target-shape`, no throw (P11.2)", () => {
    const registry = new FXNodeRegistry<FXBehaviorNode>();
    registerStandardBehaviorNodes(registry);
    // A hand-authored host target literal with a string stride and a junk input.
    const junkTargets = {
      update: {
        name: "junk",
        buffers: [{ name: "state", stride: "x" }],
        inputs: [{ name: "dt" }],
        outputs: [],
      },
    } as unknown as FXBehaviorTargets;
    const behaviorLive = new FXLiveGraph(
      new FXGraphReconciler(registry),
      new FXBehaviorLiveBackend(
        () => {
          /* install sink */
        },
        () => junkTargets,
      ),
    );

    let result: ReturnType<typeof behaviorLive.apply> | undefined;
    expect(() => {
      result = behaviorLive.apply({
        version: 2,
        nodes: {},
        connections: [],
        outputBindings: [],
      });
    }).not.toThrow();
    expect(result?.status).toBe("invalid");
    expect(result?.errors.length).toBeGreaterThan(0);
    for (const error of result?.errors ?? []) {
      expect(error.code).toBe("malformed-target-shape");
    }
    expect(result?.errors.some((error) => error.message.includes("stride"))).toBe(true);
  });

  it("throwing third-party syncLiveValues -> invalid `rebind-failed`, artifact held (P11.2)", () => {
    const registry = new FXNodeRegistry<FakeNode>();
    registry.register("sync-boom", () => {
      const node = new FakeNode({ type: "sync-boom", outputs: [socket("out")] });
      node.syncLiveValues = (): void => {
        throw new Error("sync boom");
      };
      return node;
    });
    const boomBackend = new FakeBackend();
    const boomLive = new FXLiveGraph(new FXGraphReconciler(registry), boomBackend);

    const snapshot: FXGraphSnapshotData = {
      version: 2,
      nodes: { s: { type: "sync-boom" } },
      connections: [],
      outputBindings: [{ slot: "albedo", from: { nodeId: "s", socketKey: "out" } }],
    };
    expect(boomLive.apply(snapshot).status).toBe("recompiled");
    const held = boomLive.artifact;

    // The identical snapshot routes to rebind, where syncLiveValues throws.
    let result: ReturnType<typeof boomLive.apply> | undefined;
    expect(() => {
      result = boomLive.apply(snapshot);
    }).not.toThrow();
    expect(result?.status).toBe("invalid");
    expect(result?.errors[0]?.code).toBe("rebind-failed");
    expect(result?.errors[0]?.nodeId).toBe("s");
    expect(boomLive.artifact).toBe(held);
  });

  it("throwing third-party destroy is swallowed and never re-run (P11.2)", () => {
    const registry = new FXNodeRegistry<FakeNode>();
    const made: FakeNode[] = [];
    registry.register("chain", () => {
      const node = new FakeNode({
        type: "chain",
        inputs: [socket("in")],
        outputs: [socket("out")],
      });
      made.push(node);
      return node;
    });
    registry.register("destroy-boom", () => {
      const node = new FakeNode({ type: "destroy-boom", outputs: [socket("out")] });
      const original = node.destroy.bind(node);
      node.destroy = (): void => {
        original();
        throw new Error("destroy boom");
      };
      made.push(node);
      return node;
    });
    const boomLive = new FXLiveGraph(new FXGraphReconciler(registry), new FakeBackend());

    const withBoom: FXGraphSnapshotData = {
      version: 2,
      nodes: { a: { type: "chain" }, d: { type: "destroy-boom" } },
      connections: [
        { from: { nodeId: "d", socketKey: "out" }, to: { nodeId: "a", socketKey: "in" } },
      ],
      outputBindings: [{ slot: "albedo", from: { nodeId: "a", socketKey: "out" } }],
    };
    expect(boomLive.apply(withBoom).status).toBe("recompiled");
    const boomNode = made.find((node) => node.type === "destroy-boom");

    // Removing `d` recompiles; the flush destroys it, and its throw is swallowed.
    const without: FXGraphSnapshotData = {
      version: 2,
      nodes: { a: { type: "chain" } },
      connections: [],
      outputBindings: [{ slot: "albedo", from: { nodeId: "a", socketKey: "out" } }],
    };
    expect(() => boomLive.apply(without)).not.toThrow();
    expect(boomNode?.destroyCount).toBe(1);

    // The queue was cleared before the throw - no second destroy on later flushes.
    expect(boomLive.apply(withBoom).status).toBe("recompiled");
    expect(boomLive.apply(without).status).toBe("recompiled");
    expect(boomNode?.destroyCount).toBe(1);
  });

  it("throwing prepare() still delivers discarded to pendingDestroy (P11.2, L6)", () => {
    const registry = new FXNodeRegistry<FakeNode>();
    const made: FakeNode[] = [];
    registry.register("chain", () => {
      const node = new FakeNode({ type: "chain", outputs: [socket("out")] });
      made.push(node);
      return node;
    });
    registry.register("prepare-boom", () => {
      const node = new FakeNode({ type: "prepare-boom", outputs: [socket("out")] });
      node.prepare = (): void => {
        throw new Error("prepare boom");
      };
      made.push(node);
      return node;
    });
    const boomLive = new FXLiveGraph(new FXGraphReconciler(registry), new FakeBackend());

    const chainOnly: FXGraphSnapshotData = {
      version: 2,
      nodes: { n: { type: "chain" } },
      connections: [],
      outputBindings: [{ slot: "albedo", from: { nodeId: "n", socketKey: "out" } }],
    };
    expect(boomLive.apply(chainOnly).status).toBe("recompiled");
    const original = made[0];

    // Same-id type change to a node whose prepare throws: the old instance is
    // replaced (discarded) *and* prepare fails after ingest. The discard must not
    // leak - it is destroyed once a newer artifact installs.
    let result: ReturnType<typeof boomLive.apply> | undefined;
    expect(() => {
      result = boomLive.apply({
        ...chainOnly,
        nodes: { n: { type: "prepare-boom" } },
      });
    }).not.toThrow();
    expect(result?.status).toBe("invalid");
    expect(result?.errors[0]?.code).toBe("reconcile-failed");
    expect(result?.errors[0]?.nodeId).toBe("n");
    expect(original.destroyCount).toBe(0);

    expect(boomLive.apply(chainOnly).status).toBe("recompiled");
    expect(original.destroyCount).toBe(1);
  });

  it("a 200k-node chain validates and hashes without a RangeError (P11.2)", () => {
    const registry = new FXNodeRegistry<FakeNode>();
    registry.register(
      "chain",
      () => new FakeNode({ type: "chain", inputs: [socket("in")], outputs: [socket("out")] }),
    );
    const deepLive = new FXLiveGraph(new FXGraphReconciler(registry), new FakeBackend());

    const count = 200_000;
    const nodes: Record<string, { type: string }> = {};
    const connections = [];
    for (let i = 0; i < count; i += 1) {
      nodes[`n${i.toString()}`] = { type: "chain" };
      if (i > 0) {
        connections.push({
          from: { nodeId: `n${(i - 1).toString()}`, socketKey: "out" },
          to: { nodeId: `n${i.toString()}`, socketKey: "in" },
        });
      }
    }
    const deep: FXGraphSnapshotData = {
      version: 2,
      nodes,
      connections,
      outputBindings: [
        { slot: "albedo", from: { nodeId: `n${(count - 1).toString()}`, socketKey: "out" } },
      ],
    };

    let result: ReturnType<typeof deepLive.apply> | undefined;
    expect(() => {
      result = deepLive.apply(deep);
    }).not.toThrow();
    expect(result?.status).toBe("recompiled");
    // Building + applying 200k nodes is inherently a few seconds of CPU; the assertion
    // is that it *completes* (no RangeError), so give it headroom past the 5s default
    // rather than flaking when the parallel suite starves this worker.
  }, 30_000);

  it("recovers fully on the next valid snapshot after every bad class", () => {
    const bad: FXGraphSnapshotData[] = [
      {
        version: 2,
        nodes: { a: { type: "chain" }, x: { type: "no-such-node" } },
        connections: [],
        outputBindings: [{ slot: "albedo", from: { nodeId: "a", socketKey: "out" } }],
      },
      { ...VALID, version: 99 } as FXGraphSnapshotData,
      {
        version: 2,
        nodes: { a: { type: "chain", params: { forcedThrowMessage: "bad" } } },
        connections: [],
        outputBindings: [{ slot: "albedo", from: { nodeId: "a", socketKey: "out" } }],
      },
    ];

    for (const data of bad) {
      expect(live.apply(data).status).toBe("invalid");
      // A structurally-changed valid snapshot recompiles and reinstalls.
      const recovered = live.apply({
        version: 2,
        nodes: { a: { type: "chain" }, b: { type: "chain" } },
        connections: [
          { from: { nodeId: "b", socketKey: "out" }, to: { nodeId: "a", socketKey: "in" } },
        ],
        outputBindings: [{ slot: "albedo", from: { nodeId: "a", socketKey: "out" } }],
      });
      expect(recovered.status).toBe("recompiled");
      expect(live.artifact).toBeDefined();
      // Back to the baseline for the next iteration.
      expect(live.apply(VALID).status).toBe("recompiled");
    }
  });
});
