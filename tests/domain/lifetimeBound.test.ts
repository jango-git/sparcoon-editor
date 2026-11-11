import { describe, expect, it } from "vitest";
import type { EditorGraph } from "../../src/domain/graphModel";
import { lifetimeUpperBound, unboundedLifetimeWarnings } from "../../src/domain/lifetimeBound";
import { serializeGraph } from "../../src/domain/serialize";
import { GraphKind } from "../../src/domain/nodePalette";
import { createDefaultEmitter } from "../../src/model/editorState";
import { compileEmitter } from "../../src/persistence/exportCompile";
import { emitProjectModule } from "../../src/persistence/exportTypeScript";
import { createTestState } from "../helpers/testDocument";

// The default emitter's spawn: a Lifetime node "n_life" with min 2, max 2.
function defaultBehavior(): EditorGraph {
  return createDefaultEmitter("emitter_1", "Emitter").behaviorGraph;
}

function bound(graph: EditorGraph): number | undefined {
  return lifetimeUpperBound(serializeGraph(graph, GraphKind.Behavior));
}

const LIFETIME_NODE = "n_life";

function withLifetime(graph: EditorGraph, min: number, max: number): EditorGraph {
  const node = graph.nodes[LIFETIME_NODE];
  return {
    ...graph,
    nodes: { ...graph.nodes, [LIFETIME_NODE]: { ...node, parameters: { min, max } } },
  };
}

describe("lifetimeUpperBound", () => {
  it("reads the larger of a Lifetime node's typed-in min and max", () => {
    expect(bound(defaultBehavior())).toBe(2);
    expect(bound(withLifetime(defaultBehavior(), 3, 1.5))).toBe(3);
  });

  it("follows the lifetime through a route", () => {
    const graph = defaultBehavior();
    const routed: EditorGraph = {
      ...graph,
      nodes: {
        ...graph.nodes,
        r: { id: "r", type: "$route", parameters: {}, position: { x: 0, y: 0 } },
      },
      connections: [
        ...graph.connections,
        {
          id: "c_route",
          from: { nodeId: "n_life", socketKey: "value" },
          to: { nodeId: "r", socketKey: "in" },
        },
      ],
      outputBindings: graph.outputBindings.map((binding) =>
        binding.slot === "lifetime"
          ? { ...binding, from: { nodeId: "r", socketKey: "out" } }
          : binding,
      ),
    };
    expect(bound(routed)).toBe(2);
  });

  it("has no bound for a wired min or max, or an unbound lifetime", () => {
    const graph = defaultBehavior();
    const wired: EditorGraph = {
      ...graph,
      nodes: {
        ...graph.nodes,
        k: {
          id: "k",
          type: "constant",
          parameters: { type: "float", value: 4 },
          position: { x: 0, y: 0 },
        },
      },
      connections: [
        ...graph.connections,
        {
          id: "c_max",
          from: { nodeId: "k", socketKey: "out" },
          to: { nodeId: "n_life", socketKey: "max" },
        },
      ],
    };
    expect(bound(wired)).toBeUndefined();

    const unbound: EditorGraph = {
      ...graph,
      outputBindings: graph.outputBindings.filter((binding) => binding.slot !== "lifetime"),
    };
    expect(bound(unbound)).toBeUndefined();
    expect(
      unboundedLifetimeWarnings(serializeGraph(unbound, GraphKind.Behavior)).map(
        (warning) => warning.code,
      ),
    ).toEqual(["lifetime-unbounded"]);
  });
});

describe("maxLifetime in the export", () => {
  it("ships the bound in the emitter spec, without a warning", () => {
    const emitter = createDefaultEmitter("emitter_1", "Emitter");
    const ir = compileEmitter(emitter);
    expect(ir.maxLifetime).toBe(2);
    expect(ir.warnings.map((warning) => warning.code)).not.toContain("lifetime-unbounded");
    expect(emitProjectModule(createTestState().source)).toContain("maxLifetime: 2,");
  });

  it("leaves the field out, and warns, when the graph does not tell", () => {
    const emitter = createDefaultEmitter("emitter_1", "Emitter");
    const ir = compileEmitter({
      ...emitter,
      behaviorGraph: {
        ...emitter.behaviorGraph,
        outputBindings: emitter.behaviorGraph.outputBindings.filter(
          (binding) => binding.slot !== "lifetime",
        ),
      },
    });
    expect(ir.maxLifetime).toBeUndefined();
    expect(ir.warnings.map((warning) => warning.code)).toContain("lifetime-unbounded");
  });
});
