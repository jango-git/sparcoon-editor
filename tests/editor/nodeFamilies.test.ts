import { describe, expect, it } from "vitest";
import { createEmptyGraph, type EditorGraph } from "../../src/domain/graphModel";
import { GraphKind } from "../../src/domain/nodePalette";
import { serializeGraph } from "../../src/domain/serialize";
import { nodeFamily, pruneStaleFamilyComponents } from "../../src/domain/nodeFamilies";
import { resolveNodeMeta } from "../../src/ui/graph/typeResolution";
import { ROUTE_INPUT_KEY, ROUTE_OUTPUT_KEY, ROUTE_TYPE } from "../../src/domain/fakeNodes";

// The `combine` facade is a node family: its `type` param picks a variant whose socket shape
// differs (N floats for a vecN, N vecN columns for a matN). The editor reshapes its meta for
// display; at serialize the matrix variants expand to the concrete `combine-mat{N}` engine nodes,
// while the vector variants stay on the generic `combine` node. Component keys (`x/y/z/w`) are
// shared across variants, so wires and inline values ride through without remapping.

function makeNode(
  id: string,
  type: string,
  parameters: Record<string, unknown> = {},
): EditorGraph["nodes"][string] {
  return { id, type, parameters, position: { x: 0, y: 0 } };
}

function graphWith(node: EditorGraph["nodes"][string]): EditorGraph {
  return { ...createEmptyGraph(), nodes: { [node.id]: node } };
}

function conn(
  id: string,
  fromNode: string,
  fromKey: string,
  toNode: string,
  toKey: string,
): EditorGraph["connections"][number] {
  return {
    id,
    from: { nodeId: fromNode, socketKey: fromKey },
    to: { nodeId: toNode, socketKey: toKey },
  };
}

function graphOf(
  nodes: readonly EditorGraph["nodes"][string][],
  connections: readonly EditorGraph["connections"][number][],
): EditorGraph {
  return {
    ...createEmptyGraph(),
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    connections: [...connections],
  };
}

describe("node family: combine serialize expansion", () => {
  it("expands a matrix variant to combine-mat3 and drops the now-fixed type param", () => {
    const snapshot = serializeGraph(graphWith(makeNode("cm", "combine", { type: "mat3" })));
    expect(snapshot.nodes["cm"].type).toBe("combine-mat3");
    expect(snapshot.nodes["cm"].params).toEqual({});
  });

  it("expands mat2 and mat4 to their own engine variants", () => {
    const mat2 = serializeGraph(graphWith(makeNode("cm", "combine", { type: "mat2" })));
    const mat4 = serializeGraph(graphWith(makeNode("cm", "combine", { type: "mat4" })));
    expect(mat2.nodes["cm"].type).toBe("combine-mat2");
    expect(mat4.nodes["cm"].type).toBe("combine-mat4");
  });

  it("leaves a vector variant on the generic combine node, keeping its type annotation", () => {
    const snapshot = serializeGraph(graphWith(makeNode("cm", "combine", { type: "vec3" })));
    expect(snapshot.nodes["cm"].type).toBe("combine");
    expect(snapshot.nodes["cm"].params).toMatchObject({ type: "vec3" });
  });

  it("defaults an unset/garbage type to the vector default (vec3, generic node)", () => {
    const unset = serializeGraph(graphWith(makeNode("cm", "combine", {})));
    const garbage = serializeGraph(graphWith(makeNode("cm", "combine", { type: "banana" })));
    expect(unset.nodes["cm"].type).toBe("combine");
    expect(garbage.nodes["cm"].type).toBe("combine");
  });

  it("forwards column inline values into the matrix variant verbatim", () => {
    const snapshot = serializeGraph(
      graphWith(
        makeNode("cm", "combine", { type: "mat3", x: [1, 2, 3], y: [4, 5, 6], z: [7, 8, 9] }),
      ),
    );
    expect(snapshot.nodes["cm"].params).toEqual({ x: [1, 2, 3], y: [4, 5, 6], z: [7, 8, 9] });
  });

  it("drops a stale scalar left on a matrix column (would throw at applyParams otherwise)", () => {
    // A pin switched from vector (float) to matrix (vecN column) can carry a stale scalar; it must
    // not reach the engine's vec3 column input, so it is dropped (the identity default stands).
    const snapshot = serializeGraph(
      graphWith(makeNode("cm", "combine", { type: "mat3", x: [1, 2, 3], y: 5, z: [7, 8, 9] })),
    );
    expect(snapshot.nodes["cm"].params).toEqual({ x: [1, 2, 3], z: [7, 8, 9] });
  });

  it("drops a stale vecN array left on a generic (float) component pin", () => {
    // The generic combine node coerces every one of x/y/z/w; a stale array from a prior matrix
    // variant would throw finiteScalar, so it is dropped while the real float pins survive.
    const snapshot = serializeGraph(
      graphWith(makeNode("cm", "combine", { type: "vec3", x: 1, y: [1, 2, 3], z: 2 })),
    );
    expect(snapshot.nodes["cm"].params).toEqual({ type: "vec3", x: 1, z: 2 });
  });
});

describe("node family: combine dynamic meta", () => {
  it("reshapes a matrix variant to N vecN columns and a matN output", () => {
    const node = makeNode("cm", "combine", { type: "mat3" });
    const meta = resolveNodeMeta(GraphKind.Render, node, graphWith(node));
    expect(meta?.inputs.map((socket) => socket.key)).toEqual(["x", "y", "z"]);
    expect(meta?.inputs.every((socket) => socket.type === "vec3")).toBe(true);
    expect(meta?.outputs).toHaveLength(1);
    expect(meta?.outputs[0]?.type).toBe("mat3");
  });

  it("reshapes a vector variant to N float inputs and a vecN output", () => {
    const node = makeNode("cm", "combine", { type: "vec2" });
    const meta = resolveNodeMeta(GraphKind.Render, node, graphWith(node));
    expect(meta?.inputs.map((socket) => socket.key)).toEqual(["x", "y"]);
    expect(meta?.inputs.every((socket) => socket.type === "float")).toBe(true);
    expect(meta?.outputs[0]?.type).toBe("vec2");
  });

  it("offers the full type menu (vectors + matrices) on the facade", () => {
    const node = makeNode("cm", "combine", { type: "mat4" });
    const meta = resolveNodeMeta(GraphKind.Render, node, graphWith(node));
    const typeParam = meta?.params["type"];
    const options = typeParam !== undefined && "options" in typeParam ? typeParam.options : [];
    expect(options).toEqual(["vec2", "vec3", "vec4", "mat2", "mat3", "mat4"]);
  });

  it("matrix columns carry an identity-column inline default", () => {
    const node = makeNode("cm", "combine", { type: "mat3" });
    const meta = resolveNodeMeta(GraphKind.Render, node, graphWith(node));
    expect(meta?.inputs[0]?.control?.default).toEqual([1, 0, 0]);
    expect(meta?.inputs[1]?.control?.default).toEqual([0, 1, 0]);
    expect(meta?.inputs[2]?.control?.default).toEqual([0, 0, 1]);
  });
});

describe("node family: pruning pins on a type change", () => {
  const combine = nodeFamily("combine")!;

  it("drops float pin values crossing into a matrix variant (they revert to identity columns)", () => {
    const pruned = pruneStaleFamilyComponents(combine, { type: "mat3", x: 1, y: 2, z: 3 });
    expect(pruned).toEqual({ type: "mat3" });
  });

  it("drops matrix column arrays crossing back into a vector variant", () => {
    const pruned = pruneStaleFamilyComponents(combine, {
      type: "vec3",
      x: [1, 2, 3],
      y: [4, 5, 6],
      z: [7, 8, 9],
    });
    expect(pruned).toEqual({ type: "vec3" });
  });

  it("keeps float pin values across a vector width change (the preserve-across-width nicety)", () => {
    const widened = pruneStaleFamilyComponents(combine, { type: "vec4", x: 1, y: 2, z: 3 });
    expect(widened).toEqual({ type: "vec4", x: 1, y: 2, z: 3 });
    // Narrowing keeps the now-inactive w so it returns if the width grows back.
    const narrowed = pruneStaleFamilyComponents(combine, { type: "vec2", x: 1, y: 2, z: 3, w: 4 });
    expect(narrowed).toEqual({ type: "vec2", x: 1, y: 2, z: 3, w: 4 });
  });

  it("drops columns when the matrix dimension changes (vec3 columns do not fit a mat4)", () => {
    const pruned = pruneStaleFamilyComponents(combine, {
      type: "mat4",
      x: [1, 2, 3],
      y: [4, 5, 6],
      z: [7, 8, 9],
    });
    expect(pruned).toEqual({ type: "mat4" });
  });
});

describe("node family: split serialize expansion (wire-driven)", () => {
  it("expands to split-mat3 when a concrete matrix node feeds its input", () => {
    const snapshot = serializeGraph(
      graphOf(
        [makeNode("rot", "rotation-matrix"), makeNode("sp", "split")],
        [conn("c", "rot", "out", "sp", "v")],
      ),
    );
    expect(snapshot.nodes["sp"].type).toBe("split-mat3");
    expect(snapshot.nodes["rot"].type).toBe("rotation-matrix");
  });

  it("resolves a matrix through the upstream combine facade (facade feeds facade)", () => {
    const snapshot = serializeGraph(
      graphOf(
        [makeNode("cm", "combine", { type: "mat4" }), makeNode("sp", "split")],
        [conn("c", "cm", "out", "sp", "v")],
      ),
    );
    expect(snapshot.nodes["cm"].type).toBe("combine-mat4");
    expect(snapshot.nodes["sp"].type).toBe("split-mat4");
  });

  it("stays on the generic split node for a vector input", () => {
    const snapshot = serializeGraph(
      graphOf(
        [makeNode("c", "constant", { type: "vec3" }), makeNode("sp", "split")],
        [conn("c1", "c", "out", "sp", "v")],
      ),
    );
    expect(snapshot.nodes["sp"].type).toBe("split");
  });

  it("stays on the generic split node when unwired", () => {
    const snapshot = serializeGraph(graphWith(makeNode("sp", "split")));
    expect(snapshot.nodes["sp"].type).toBe("split");
  });

  it("resolves a matrix through a route into split-mat3 (route then spliced out)", () => {
    const snapshot = serializeGraph(
      graphOf(
        [makeNode("rot", "rotation-matrix"), makeNode("r", ROUTE_TYPE), makeNode("sp", "split")],
        [
          conn("c1", "rot", "out", "r", ROUTE_INPUT_KEY),
          conn("c2", "r", ROUTE_OUTPUT_KEY, "sp", "v"),
        ],
      ),
    );
    expect(snapshot.nodes["sp"].type).toBe("split-mat3");
    expect(snapshot.nodes["r"]).toBeUndefined(); // the route is visual-only, spliced out
    expect(snapshot.connections).toContainEqual({
      from: { nodeId: "rot", socketKey: "out" },
      to: { nodeId: "sp", socketKey: "v" },
    });
  });

  it("leaves a non-family node (combine-color) untouched", () => {
    const snapshot = serializeGraph(graphWith(makeNode("cc", "combine-color")));
    expect(snapshot.nodes["cc"].type).toBe("combine-color");
  });
});

describe("node family: dangling edges pruned when a facade narrows", () => {
  it("drops a wire into a matrix column the combine variant no longer exposes", () => {
    // combine is mat3 (columns x/y/z, no w); a stale wire into `w` (from a wider variant) is dropped,
    // while the live wire into `x` survives - else combine-mat3 gets an unknown `w` socket.
    const snapshot = serializeGraph(
      graphOf(
        [makeNode("p", "constant", { type: "vec3" }), makeNode("cm", "combine", { type: "mat3" })],
        [conn("cx", "p", "out", "cm", "x"), conn("cw", "p", "out", "cm", "w")],
      ),
    );
    expect(snapshot.nodes["cm"].type).toBe("combine-mat3");
    const intoCombine = snapshot.connections
      .filter((c) => c.to.nodeId === "cm")
      .map((c) => c.to.socketKey);
    expect(intoCombine).toContain("x");
    expect(intoCombine).not.toContain("w");
  });

  it("drops a wire out of a split column the variant no longer exposes", () => {
    const snapshot = serializeGraph(
      graphOf(
        [makeNode("rot", "rotation-matrix"), makeNode("sp", "split"), makeNode("d", "dot")],
        [
          conn("cv", "rot", "out", "sp", "v"),
          conn("ca", "sp", "x", "d", "a"),
          conn("cb", "sp", "w", "d", "b"),
        ],
      ),
    );
    expect(snapshot.nodes["sp"].type).toBe("split-mat3");
    const outOfSplit = snapshot.connections
      .filter((c) => c.from.nodeId === "sp")
      .map((c) => c.from.socketKey);
    expect(outOfSplit).toContain("x");
    expect(outOfSplit).not.toContain("w");
  });

  it("drops an output binding fed by a split column the variant no longer exposes", () => {
    const graph: EditorGraph = {
      ...createEmptyGraph(),
      nodes: { rot: makeNode("rot", "rotation-matrix"), sp: makeNode("sp", "split") },
      connections: [conn("cv", "rot", "out", "sp", "v")],
      outputBindings: [
        { slot: "position", from: { nodeId: "sp", socketKey: "x" } },
        { slot: "position", from: { nodeId: "sp", socketKey: "w" } },
      ],
    };
    const snapshot = serializeGraph(graph, GraphKind.Behavior);
    const bound = snapshot.outputBindings
      .filter((b) => b.from.nodeId === "sp")
      .map((b) => b.from.socketKey);
    expect(bound).toContain("x");
    expect(bound).not.toContain("w");
  });
});

describe("node family: downstream type resolution through a matrix split", () => {
  it("recolors a generic node fed by a matrix-split column to the column vecN (not base float)", () => {
    // rotation-matrix (mat3) -> split (columns vec3) -> split.x -> binary-op.a.
    const graph = graphOf(
      [makeNode("rot", "rotation-matrix"), makeNode("sp", "split"), makeNode("b", "binary-op")],
      [conn("cv", "rot", "out", "sp", "v"), conn("ca", "sp", "x", "b", "a")],
    );
    const meta = resolveNodeMeta(GraphKind.Render, graph.nodes["b"], graph);
    expect(meta?.outputs.find((s) => s.key === "out")?.type).toBe("vec3");
  });

  it("resolves a second split fed by a matrix-split column as a vector split (vec3 input)", () => {
    const graph = graphOf(
      [makeNode("rot", "rotation-matrix"), makeNode("sp", "split"), makeNode("sp2", "split")],
      [conn("cv", "rot", "out", "sp", "v"), conn("cx", "sp", "x", "sp2", "v")],
    );
    const meta = resolveNodeMeta(GraphKind.Render, graph.nodes["sp2"], graph);
    expect(meta?.inputs[0]?.type).toBe("vec3");
    expect(meta?.outputs.map((s) => s.key)).toEqual(["x", "y", "z"]);
    expect(meta?.outputs.every((s) => s.type === "float")).toBe(true);
  });
});

describe("binary-op: unconnected generic pin follows the resolved width", () => {
  it("sizes b's inline control to vec3 when only a is wired (no type param on binary-op itself)", () => {
    const graph = graphOf(
      [makeNode("rot", "rotation-matrix"), makeNode("sp", "split"), makeNode("bin", "binary-op")],
      [conn("cv", "rot", "out", "sp", "v"), conn("ca", "sp", "x", "bin", "a")],
    );
    const meta = resolveNodeMeta(GraphKind.Render, graph.nodes["bin"], graph);
    const b = meta?.inputs.find((s) => s.key === "b");
    expect(b?.type).toBe("vec3");
    expect(b?.control).toEqual({ default: 0 });
  });
});

describe("node family: color alias normalization", () => {
  it("resolves a color constant's output to vec4, not the UI-only 'color' alias", () => {
    const graph = graphOf(
      [makeNode("c", "constant", { type: "color" }), makeNode("b", "binary-op")],
      [conn("e", "c", "out", "b", "a")],
    );
    const meta = resolveNodeMeta(GraphKind.Render, graph.nodes["b"], graph);
    expect(meta?.outputs.find((s) => s.key === "out")?.type).toBe("vec4");
  });
});

describe("node family: split dynamic meta (wire-driven)", () => {
  it("reshapes to N vecN column outputs for a matrix input", () => {
    const graph = graphOf(
      [makeNode("rot", "rotation-matrix"), makeNode("sp", "split")],
      [conn("c", "rot", "out", "sp", "v")],
    );
    const meta = resolveNodeMeta(GraphKind.Render, graph.nodes["sp"], graph);
    expect(meta?.inputs.map((s) => s.key)).toEqual(["v"]);
    expect(meta?.inputs[0]?.type).toBe("mat3");
    expect(meta?.outputs.map((s) => s.key)).toEqual(["x", "y", "z"]);
    expect(meta?.outputs.every((s) => s.type === "vec3")).toBe(true);
  });

  it("reshapes to N float outputs for a vector input", () => {
    const graph = graphOf(
      [makeNode("c", "constant", { type: "vec2" }), makeNode("sp", "split")],
      [conn("c1", "c", "out", "sp", "v")],
    );
    const meta = resolveNodeMeta(GraphKind.Render, graph.nodes["sp"], graph);
    expect(meta?.inputs[0]?.type).toBe("vec2");
    expect(meta?.outputs.map((s) => s.key)).toEqual(["x", "y"]);
    expect(meta?.outputs.every((s) => s.type === "float")).toBe(true);
  });

  it("shows the neutral shape (generic input, four float outputs) when unwired", () => {
    const graph = graphWith(makeNode("sp", "split"));
    const meta = resolveNodeMeta(GraphKind.Render, graph.nodes["sp"], graph);
    expect(meta?.inputs[0]?.type).toBe("T");
    expect(meta?.outputs.map((s) => s.key)).toEqual(["x", "y", "z", "w"]);
    expect(meta?.outputs.every((s) => s.type === "float")).toBe(true);
  });
});

// `read-attribute-components` is a param-driven family like `combine` (its width comes from the
// node's own `type` param, not a wired input - it has no inputs at all), but unlike `combine`/
// `split` a user attribute is never a matrix, so it never expands to a concrete variant type at
// serialize: the one engine node handles every width itself.
describe("node family: read-attribute-components dynamic meta (param-driven)", () => {
  it("reshapes to N float outputs matching the selected attribute width", () => {
    const widths: readonly (readonly [string, readonly string[]])[] = [
      ["float", ["x"]],
      ["vec2", ["x", "y"]],
      ["vec3", ["x", "y", "z"]],
      ["vec4", ["x", "y", "z", "w"]],
    ];
    for (const [type, keys] of widths) {
      const node = makeNode("ra", "read-attribute-components", { name: "tint", type });
      const meta = resolveNodeMeta(GraphKind.Render, node, graphWith(node));
      expect(meta?.inputs).toEqual([]);
      expect(meta?.outputs.map((s) => s.key)).toEqual(keys);
      expect(meta?.outputs.every((s) => s.type === "float")).toBe(true);
    }
  });

  it("defaults an unset/garbage type to the widest shape (vec4, all four outputs)", () => {
    const unset = makeNode("ra", "read-attribute-components", { name: "tint" });
    const garbage = makeNode("ra2", "read-attribute-components", { name: "tint", type: "banana" });
    expect(
      resolveNodeMeta(GraphKind.Render, unset, graphWith(unset))?.outputs.map((s) => s.key),
    ).toEqual(["x", "y", "z", "w"]);
    expect(
      resolveNodeMeta(GraphKind.Render, garbage, graphWith(garbage))?.outputs.map((s) => s.key),
    ).toEqual(["x", "y", "z", "w"]);
  });

  it("offers the plain attribute type menu, not the combine/split matrix options", () => {
    const node = makeNode("ra", "read-attribute-components", { name: "tint", type: "vec3" });
    const meta = resolveNodeMeta(GraphKind.Render, node, graphWith(node));
    const typeParam = meta?.params["type"];
    const options = typeParam !== undefined && "options" in typeParam ? typeParam.options : [];
    expect(options).toEqual(["float", "vec2", "vec3", "vec4"]);
  });
});

describe("node family: read-attribute-components serialize (identity, no matrix variant)", () => {
  it("stays on the one engine node type for every width - no concrete variant to expand to", () => {
    for (const type of ["float", "vec2", "vec3", "vec4"]) {
      const snapshot = serializeGraph(
        graphWith(makeNode("ra", "read-attribute-components", { name: "tint", type })),
      );
      expect(snapshot.nodes["ra"].type).toBe("read-attribute-components");
      expect(snapshot.nodes["ra"].params).toEqual({ name: "tint", type });
    }
  });

  it("drops a wire out of a component the narrower variant no longer exposes", () => {
    const snapshot = serializeGraph(
      graphOf(
        [
          makeNode("ra", "read-attribute-components", { name: "tint", type: "vec2" }),
          makeNode("d", "dot"),
        ],
        [conn("ca", "ra", "x", "d", "a"), conn("cb", "ra", "w", "d", "b")],
      ),
    );
    const outOfRead = snapshot.connections
      .filter((c) => c.from.nodeId === "ra")
      .map((c) => c.from.socketKey);
    expect(outOfRead).toContain("x");
    expect(outOfRead).not.toContain("w"); // vec2 only exposes x/y
  });
});
