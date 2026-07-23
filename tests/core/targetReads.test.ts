import { describe, expect, it } from "vitest";
import type { FXValidationResult } from "../../src/engine/core/compiler/FXCompilerError";
import {
  collectReachableNodeIds,
  topologicalOrder,
} from "../../src/engine/core/compiler/FXGraphTraversal.Internal";
import { structuralHash } from "../../src/engine/core/compiler/FXStructuralHash.Internal";
import type { FXValidatableTarget } from "../../src/engine/core/compiler/FXValidation.Internal";
import { validateGraph } from "../../src/engine/core/compiler/FXValidation.Internal";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXGraphReconciler } from "../../src/engine/core/live/FXGraphReconciler";
import { FXLiveGraph } from "../../src/engine/core/live/FXLiveGraph";
import type { FXLiveBackend } from "../../src/engine/core/live/FXLiveBackend";
import type { FXGraphSnapshotData } from "../../src/engine/core/live/FXSnapshotData";
import { resolveValueType } from "../../src/engine/core/socket/FXValueType";
import type { FakeArtifact } from "../helpers/fakeNodes";
import { FakeBackend, FakeNode, makeRegistry, socket } from "../helpers/fakeNodes";

const FLOAT = resolveValueType("float");

/** A target exposing a single fragment-only builtin `p_uv` and one optional output. */
const TARGET: FXValidatableTarget = {
  name: "reads-target",
  outputs: [{ slot: "out", type: FLOAT, required: false }],
  inputs: [{ name: "p_uv", stages: ["fragment"] }],
};

/** A one-node graph whose node is reachable through the `out` slot binding. */
function readerGraph(node: FakeNode): FXGraph<FakeNode> {
  const graph = new FXGraph<FakeNode>();
  graph.ingest({
    nodes: new Map([["r", node]]),
    connections: [],
    outputBindings: [{ slot: "out", from: { nodeId: "r", socketKey: "out" } }],
  });
  return graph;
}

function reader(opts: { targetReads?: readonly string[]; stage?: string }): FakeNode {
  return new FakeNode({ type: "reader", outputs: [socket("out")], ...opts });
}

describe("validateGraph - target-input reads", () => {
  it("flags a read of a builtin the target does not provide (nodeId attached)", () => {
    const result = validateGraph(
      readerGraph(reader({ targetReads: ["MISSING"], stage: "fragment" })),
      TARGET,
    );

    const error = result.errors.find((e) => e.code === "unknown-target-input");
    expect(error).toBeDefined();
    expect(error?.nodeId).toBe("r");
    expect(result.ok).toBe(false);
  });

  it("flags a read of a builtin in an illegal stage", () => {
    const result = validateGraph(
      readerGraph(reader({ targetReads: ["p_uv"], stage: "vertex" })),
      TARGET,
    );

    const error = result.errors.find((e) => e.code === "target-input-stage-mismatch");
    expect(error).toBeDefined();
    expect(error?.nodeId).toBe("r");
    expect(error?.socketKey).toBe("p_uv");
  });

  it("accepts a read that exists and is stage-legal", () => {
    const result = validateGraph(
      readerGraph(reader({ targetReads: ["p_uv"], stage: "fragment" })),
      TARGET,
    );

    expect(
      result.errors.some(
        (e) => e.code === "unknown-target-input" || e.code === "target-input-stage-mismatch",
      ),
    ).toBe(false);
  });

  it("skips a node that does not declare its reads (honest degradation)", () => {
    // No targetReads -> validation cannot know what it reads -> it is not checked,
    // even though the target provides no matching builtin.
    const result = validateGraph(readerGraph(reader({ stage: "fragment" })), TARGET);

    expect(result.errors.some((e) => e.code === "unknown-target-input")).toBe(false);
  });

  it("skips the reads check entirely when the target exposes no inputs", () => {
    const noInputs: FXValidatableTarget = { name: "no-inputs", outputs: TARGET.outputs };
    const result = validateGraph(
      readerGraph(reader({ targetReads: ["MISSING"], stage: "fragment" })),
      noInputs,
    );

    expect(result.errors.some((e) => e.code === "unknown-target-input")).toBe(false);
  });
});

/** Backend wiring FXLiveGraph to the real reads validation against {@link TARGET}. */
class ReadsBackend implements FXLiveBackend<FakeNode, FakeArtifact> {
  public compileCount = 0;

  public validate(graph: FXGraph<FakeNode>): FXValidationResult {
    return validateGraph(graph, TARGET);
  }

  public previewHash(graph: FXGraph<FakeNode>): string {
    const reachable = collectReachableNodeIds(graph);
    const { order } = topologicalOrder(graph, reachable);
    return structuralHash(graph, TARGET.name, order);
  }

  public compile(graph: FXGraph<FakeNode>): FakeArtifact {
    this.compileCount += 1;
    return { hash: this.previewHash(graph) };
  }

  public install(): void {
    // no-op
  }
}

function snapshot(nodeId: string, type: string): FXGraphSnapshotData {
  return {
    version: 2,
    nodes: { [nodeId]: { type } },
    connections: [],
    outputBindings: [{ slot: "out", from: { nodeId, socketKey: "out" } }],
  };
}

describe("FXLiveGraph.apply - target-input reads", () => {
  it("routes a bad-read graph to invalid and holds the last good artifact", () => {
    const { registry } = makeRegistry([
      { type: "good", outputs: [socket("out")], targetReads: ["p_uv"], stage: "fragment" },
      { type: "bad", outputs: [socket("out")], targetReads: ["MISSING"], stage: "fragment" },
    ]);
    const live = new FXLiveGraph(new FXGraphReconciler(registry), new ReadsBackend());

    expect(live.apply(snapshot("g", "good")).status).toBe("recompiled");
    const held = live.artifact;
    expect(held).toBeDefined();

    const result = live.apply(snapshot("b", "bad"));
    expect(result.status).toBe("invalid");
    expect(result.errors.some((e) => e.code === "unknown-target-input")).toBe(true);
    expect(live.artifact).toBe(held);
  });

  it("holds the last good artifact when a validated graph throws in compile", () => {
    // Simulates a third-party node with no reads declaration: validation passes
    // (it is skipped), but build() throws - apply must not propagate the throw.
    const registry = makeRegistry([
      { type: "chain", inputs: [socket("in")], outputs: [socket("out")] },
    ]);
    const backend = new FakeBackend();
    const live = new FXLiveGraph(new FXGraphReconciler(registry.registry), backend);

    const full: FXGraphSnapshotData = {
      version: 2,
      nodes: { a: { type: "chain" }, b: { type: "chain" } },
      connections: [
        { from: { nodeId: "b", socketKey: "out" }, to: { nodeId: "a", socketKey: "in" } },
      ],
      outputBindings: [{ slot: "albedo", from: { nodeId: "a", socketKey: "out" } }],
    };
    const reduced: FXGraphSnapshotData = {
      version: 2,
      nodes: { a: { type: "chain" } },
      connections: [],
      outputBindings: [{ slot: "albedo", from: { nodeId: "a", socketKey: "out" } }],
    };

    live.apply(full);
    const held = live.artifact;
    backend.compileThrows = true;

    let result;
    expect(() => {
      result = live.apply(reduced); // structural change forces the recompile path
    }).not.toThrow();

    expect(result?.status).toBe("invalid");
    expect(result?.errors[0]?.code).toBe("compile-failed");
    expect(result?.errors[0]?.message).toContain("compile boom");
    expect(live.artifact).toBe(held);
  });
});
