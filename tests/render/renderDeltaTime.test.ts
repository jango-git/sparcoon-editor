import { describe, expect, it } from "vitest";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import { buildParticleTarget } from "../../src/engine/render/target/FXParticleRenderTarget";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { renderRegistry } from "../helpers/stdRegistry";

/**
 * The render `delta-time` source reads the host builtin `u_deltaTime` (a target input the
 * host provides). Preserves the u_deltaTime plumbing coverage from the removed material-splice
 * test, now asserted on the compiled shader IR directly (the string the material used to splice).
 */
function deltaGraph(): FXGraph<FXRenderNode> {
  const rr = renderRegistry();
  const graph = new FXGraph<FXRenderNode>();
  graph.ingest({
    // albedo = vec4 assembled from the delta-time float in its x component.
    nodes: new Map([
      ["dt", rr.create("delta-time", undefined)],
      ["rgba", rr.create("combine", { type: "vec4" })],
    ]),
    connections: [
      { from: { nodeId: "dt", socketKey: "out" }, to: { nodeId: "rgba", socketKey: "x" } },
    ],
    outputBindings: [{ slot: "albedo", from: { nodeId: "rgba", socketKey: "out" } }],
  });
  return graph;
}

describe("render delta-time source (u_deltaTime plumbing)", () => {
  it("compiles a delta-time node and references the host u_deltaTime builtin", () => {
    const shader = new FXCompilerBaseline().compile(deltaGraph(), buildParticleTarget([]));
    // combine -> albedo is a fragment slot, so the delta-time read lands in the fragment body.
    expect(shader.fragment.body.join("\n")).toContain("u_deltaTime");
  });
});
