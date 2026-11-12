import { describe, expect, it } from "vitest";

import { depthFadeModeErrors } from "../../src/domain/depthFadeChecks";
import { collectRenderCapabilities } from "../../src/engine/core/compiler/collectRenderCapabilities";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { renderArtifactBody } from "../../src/engine/emit/artifactLiterals";
import { compileMeshArtifact } from "../../src/engine/emit/compileMeshArtifact";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FX_MESH_TARGET } from "../../src/engine/render/target/FXParticleRenderTarget";
import { renderRegistry } from "../helpers/stdRegistry";

/** albedo = vec4(1, 1, 1, fade): soft by Depth Fade; `wired: false` leaves the fade unreachable. */
function fadeGraph(wired = true): FXGraph<FXRenderNode> {
  const rr = renderRegistry();
  const graph = new FXGraph<FXRenderNode>();
  graph.ingest({
    nodes: new Map([
      ["fade", rr.create("depth-fade", undefined)],
      ["rgba", rr.create("combine", { type: "vec4" })],
    ]),
    connections: wired
      ? [{ from: { nodeId: "fade", socketKey: "fade" }, to: { nodeId: "rgba", socketKey: "w" } }]
      : [],
    outputBindings: [{ slot: "albedo", from: { nodeId: "rgba", socketKey: "out" } }],
  });
  return graph;
}

describe("depth-fade", () => {
  it("calls the runtime's fxDepthFade in the fragment stage", () => {
    const shader = new FXCompilerBaseline().compile(fadeGraph(), FX_MESH_TARGET);
    expect(shader.fragment.body.join("\n")).toContain("fxDepthFade(");
    expect(shader.vertex.body.join("\n")).not.toContain("fxDepthFade");
  });

  it("asks the runtime for the scene depth only when reachable", () => {
    expect(collectRenderCapabilities(fadeGraph())).toEqual({
      lightingIntrinsics: [],
      sceneDepth: true,
    });
    expect(collectRenderCapabilities(fadeGraph(false)).sceneDepth).toBe(false);
    expect(compileMeshArtifact(fadeGraph()).render.sceneDepth).toBe(true);
  });

  it("exports the capability with the artifact", () => {
    const shader = new FXCompilerBaseline().compile(fadeGraph(), FX_MESH_TARGET);
    const body = renderArtifactBody(
      shader,
      { type: "primitive", primitive: "plane" },
      [],
      "blending",
    );
    expect(body).toContain("  sceneDepth: true,");
  });

  it("is an error on the node in a depth-writing render mode, none in blending", () => {
    expect(depthFadeModeErrors(fadeGraph(), "blending")).toEqual([]);
    for (const mode of ["alphaTest", "alphaHash", "opaque"] as const) {
      const errors = depthFadeModeErrors(fadeGraph(), mode);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        code: "depth-fade-needs-blending",
        nodeId: "fade",
        params: { mode },
      });
      expect(errors[0].message).toContain(mode);
    }
    // An unreachable Depth Fade reads nothing, so it constrains nothing.
    expect(depthFadeModeErrors(fadeGraph(false), "opaque")).toEqual([]);
  });
});
