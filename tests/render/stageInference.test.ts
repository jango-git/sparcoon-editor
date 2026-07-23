import { describe, expect, it } from "vitest";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import { buildParticleTarget } from "../../src/engine/render/target/FXParticleRenderTarget";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { renderRegistry } from "../helpers/stdRegistry";

describe("render placement inference", () => {
  it("places a flexible constant in vertex when it feeds a vertex output slot", () => {
    const r = renderRegistry();
    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes: new Map([
        ["col", r.create("constant", { type: "vec4", value: [1, 1, 1, 1] })],
        ["off", r.create("constant", { type: "vec3", value: [0, 1, 0] })],
        ["compose", r.create("compose-transform", { scale: [1, 1, 1] })],
      ]),
      connections: [
        {
          from: { nodeId: "off", socketKey: "out" },
          to: { nodeId: "compose", socketKey: "position" },
        },
      ],
      outputBindings: [
        { slot: "albedo", from: { nodeId: "col", socketKey: "out" } }, // fragment slot
        { slot: "particleTransform", from: { nodeId: "compose", socketKey: "out" } }, // vertex slot
      ],
    });
    const target = buildParticleTarget([]);

    // Old model: a flexible constant defaulted to fragment, so the one feeding the vertex
    // transform slot errored (a fragment value cannot flow into a vertex slot). Placement
    // inference puts the constant (through compose-transform) in vertex instead - no error.
    expect(new FXCompilerBaseline().validate(graph, target).ok).toBe(true);

    const shader = new FXCompilerBaseline().compile(graph, target);
    expect(shader.outputs["albedo"]).toBeDefined();
    expect(shader.outputs["particleTransform"]).toBeDefined();
    // The offset constant is emitted in the vertex body (its value reaches the slot
    // without a fragment->vertex varying, which is impossible).
    expect(shader.vertex.body.length).toBeGreaterThan(0);
  });

  it("keeps a flexible constant in fragment when it feeds only a fragment slot", () => {
    const r = renderRegistry();
    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes: new Map([["col", r.create("constant", { type: "vec4", value: [1, 0, 0, 1] })]]),
      connections: [],
      outputBindings: [{ slot: "albedo", from: { nodeId: "col", socketKey: "out" } }],
    });
    const target = buildParticleTarget([]);
    const shader = new FXCompilerBaseline().compile(graph, target);
    expect(shader.outputs["albedo"]).toBeDefined();
    expect(shader.fragment.body.length).toBeGreaterThan(0);
  });
});
