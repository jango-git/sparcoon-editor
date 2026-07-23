import { describe, expect, it } from "vitest";
import { FXGraph } from "../../src/engine/core/FXGraph";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import type { FXGeometryPrimitive, FXGeometrySource } from "sparcoon";
import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import { compileToArtifacts } from "../../src/engine/emit/compileToArtifacts";
import { emitEffectModule } from "../../src/engine/emit/emitEffectModule";
import { behaviorRegistry, renderRegistry } from "../helpers/stdRegistry";

function primitive(primitive: FXGeometryPrimitive): FXGeometrySource {
  return { type: "primitive", primitive };
}

// The instanced geometry is a render-artifact field (a built-in primitive selector). A billboard
// is `"plane"` + a camera-facing particleTransform; `"box"`/`"sphere"` render 3D particles.

function graphs(): { render: FXGraph<FXRenderNode>; behavior: FXGraph<FXBehaviorNode> } {
  const rr = renderRegistry();
  const render = new FXGraph<FXRenderNode>();
  render.ingest({
    nodes: new Map([["c", rr.create("constant", { type: "vec4", value: [1, 1, 1, 1] })]]),
    connections: [],
    outputBindings: [{ slot: "albedo", from: { nodeId: "c", socketKey: "out" } }],
  });
  const br = behaviorRegistry();
  const behavior = new FXGraph<FXBehaviorNode>();
  behavior.ingest({
    nodes: new Map<string, FXBehaviorNode>([
      ["life", br.create("lifetime", { min: 1, max: 1 })],
      ["pos", br.create("spawn-box", { size: [0, 0, 0], center: [0, 0, 0] })],
    ]),
    connections: [],
    outputBindings: [
      {
        slot: "lifetime",
        from: { nodeId: "life", socketKey: "value" },
        phase: FXBehaviorPhase.SPAWN,
      },
      {
        slot: "position",
        from: { nodeId: "pos", socketKey: "position" },
        phase: FXBehaviorPhase.SPAWN,
      },
    ],
  });
  return { render, behavior };
}

describe("render artifact geometry", () => {
  it("defaults to plane when unspecified", () => {
    const { render, behavior } = graphs();
    expect(compileToArtifacts(render, behavior).render.geometry).toEqual(primitive("plane"));
  });

  it("carries the requested primitive", () => {
    const { render, behavior } = graphs();
    expect(
      compileToArtifacts(render, behavior, { geometry: primitive("box") }).render.geometry,
    ).toEqual(primitive("box"));
    expect(
      compileToArtifacts(render, behavior, { geometry: primitive("sphere") }).render.geometry,
    ).toEqual(primitive("sphere"));
  });

  it("folds geometry into the structural hash (a primitive change rebuilds)", () => {
    const { render, behavior } = graphs();
    const plane = compileToArtifacts(render, behavior, { geometry: primitive("plane") }).hash;
    const box = compileToArtifacts(render, behavior, { geometry: primitive("box") }).hash;
    expect(plane).not.toBe(box);
  });

  it("serializes geometry into the emitted ESM module", () => {
    const { render, behavior } = graphs();
    expect(emitEffectModule(render, behavior, { geometry: primitive("sphere") })).toContain(
      'geometry: {"type":"primitive","primitive":"sphere"}',
    );
  });
});
