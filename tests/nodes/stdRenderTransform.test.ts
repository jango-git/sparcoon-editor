import { describe, expect, it } from "vitest";

import type { FXGraph } from "../../src/engine/core/FXGraph";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FX_PARTICLE_TARGET } from "../../src/engine/render/target/FXParticleRenderTarget";
import { bind, edge, graphOf } from "../helpers/graphBuild";
import { renderRegistry } from "../helpers/stdRegistry";

// The transform nodes produce the two mat4 render slots. A billboard is `look-at-camera`
// feeding `particleTransform` (directly or through `compose-transform`), so these graphs
// prove the camera-facing rotation and the PRS compose land in the vertex program.

const reg = renderRegistry();
const compiler = new FXCompilerBaseline();

/** `rotation` (a mat3 producer) -> compose-transform -> particleTransform, white albedo. */
function billboardGraph(
  rotation: FXRenderNode,
  compose: Record<string, unknown> = { position: [0, 0, 0], scale: [1, 1, 1] },
): FXGraph<FXRenderNode> {
  return graphOf(
    {
      look: rotation,
      compose: reg.create("compose-transform", compose),
      col: reg.create("constant", { type: "color", value: [1, 1, 1, 1] }),
    },
    [edge("look", "out", "compose", "rotation")],
    [bind("particleTransform", "compose", "out"), bind("albedo", "col", "out")],
  );
}

function vertexOf(graph: FXGraph<FXRenderNode>): string {
  return compiler.compile(graph, FX_PARTICLE_TARGET).vertex.body.join("\n");
}

describe("standard render transform nodes", () => {
  it("look-at-camera -> compose-transform drives a camera-facing particleTransform (vertex)", () => {
    const graph = billboardGraph(reg.create("look-at-camera", { roll: 0 }), {
      position: [0, 0, 0],
      scale: [2, 2, 1],
    });
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    const vertex = shader.vertex.body.join("\n");
    // The whole chain lands in the vertex stage (particleTransform is a vertex slot).
    expect(shader.outputs["particleTransform"]).toBeDefined();
    expect(vertex).toContain("mat4");
    // look-at-camera reads the view matrix and transposes its rotation to build the basis.
    expect(vertex).toContain("viewMatrix");
    expect(vertex.toLowerCase()).toContain("transpose");
  });

  it("compose-transform with an unwired rotation still compiles (identity default)", () => {
    const graph = graphOf(
      {
        compose: reg.create("compose-transform", { position: [1, 0, 0], scale: [1, 1, 1] }),
        col: reg.create("constant", { type: "color", value: [1, 1, 1, 1] }),
      },
      [],
      [bind("vertexTransform", "compose", "out"), bind("albedo", "col", "out")],
    );
    expect(compiler.compile(graph, FX_PARTICLE_TARGET).outputs["vertexTransform"]).toBeDefined();
  });

  it.each(["x", "y", "z"] as const)(
    "look-at-camera locked to axis %s compiles a cylindrical (cross-product) basis",
    (axis) => {
      const vertex = vertexOf(billboardGraph(reg.create("look-at-camera", { roll: 0, axis })));
      expect(vertex.toLowerCase()).toContain("cross");
      expect(vertex.toLowerCase()).toContain("normalize");
    },
  );

  it('look-at-camera axis "all" ignores cameraModel (no fixed axis to build a per-particle direction against)', () => {
    const vertex = vertexOf(
      billboardGraph(reg.create("look-at-camera", { roll: 0, cameraModel: "point" })),
    );
    expect(vertex).toContain("viewMatrix");
    expect(vertex).not.toContain("cameraPosition");
  });

  it('look-at-camera defaults to axis "all" (the unconstrained billboard, no cross product)', () => {
    const vertex = vertexOf(billboardGraph(reg.create("look-at-camera", { roll: 0 })));
    expect(vertex.toLowerCase()).not.toContain("cross");
  });

  it("look-at-camera feeding a fragment shading normal is computed per vertex", () => {
    // viewMatrix is readable in both stages, so a fragment consumer may place the basis there -
    // but it reads only the camera, the same at every fragment, so it is computed per vertex and
    // its result carried across instead.
    const graph = graphOf(
      {
        look: reg.create("look-at-camera"),
        td: reg.create("transform-direction", { v: [0, 0, 1] }),
        lit: reg.create("lambert-shading"),
      },
      [edge("look", "out", "td", "m"), edge("td", "out", "lit", "normal")],
      [bind("albedo", "lit", "color")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    expect(shader.vertex.body.join("\n")).toContain("viewMatrix");
    expect(shader.fragment.body.join("\n")).not.toContain("viewMatrix");
    expect(shader.fragment.body.join("\n")).toContain("fxLambertShade");
  });
});

describe('camera-facing rotations with cameraModel: "point"', () => {
  // A point camera aims each particle at the camera position instead of sharing the view
  // forward, so the rotation reads the particle position and cameraPosition, not viewMatrix.
  it.each([
    ["look-at-camera", { roll: 0, axis: "y", cameraModel: "point" }],
    ["align-to-velocity", { velocity: [1, 0, 0], cameraModel: "point" }],
  ] as const)("%s reads PARTICLE_POSITION/cameraPosition instead of viewMatrix", (type, params) => {
    const vertex = vertexOf(billboardGraph(reg.create(type, params)));
    expect(vertex).toContain("cameraPosition");
    expect(vertex).toContain("PARTICLE_POSITION");
    // Particle position is already world space by convention - no modelMatrix conversion.
    expect(vertex).not.toContain("modelMatrix");
    expect(vertex).not.toContain("viewMatrix");
  });
});
