import { describe, expect, it } from "vitest";
import { FXEmitter } from "sparcoon/editor";
import type { FXBehaviorArtifact, FXRenderArtifact } from "sparcoon";
import { FXGraph } from "../../src/engine/core/FXGraph";
import type { FXConnection } from "../../src/engine/core/FXGraph";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import { compileToArtifacts } from "../../src/engine/emit/compileToArtifacts";
import { behaviorRegistry, renderRegistry } from "../helpers/stdRegistry";

// End-to-end: the engine compiles a graph whose `particleTransform` is a camera-facing
// rotation (a billboard, expressed as nodes); the runtime assembles it into the unlit
// ShaderMaterial (self-contained) or splices it into the real lambert ShaderLib template, and
// we assert the unified, geometry-agnostic vertex epilogue - no hardcoded billboard math survives.

function edge(fromNode: string, fromKey: string, toNode: string, toKey: string): FXConnection {
  return {
    from: { nodeId: fromNode, socketKey: fromKey },
    to: { nodeId: toNode, socketKey: toKey },
  };
}

/** A render graph: look-at-camera -> compose-transform -> particleTransform, + a constant albedo. */
function billboardRender(): FXGraph<FXRenderNode> {
  const rr = renderRegistry();
  const g = new FXGraph<FXRenderNode>();
  g.ingest({
    nodes: new Map([
      ["look", rr.create("look-at-camera", { roll: 0 })],
      ["compose", rr.create("compose-transform", { position: [0, 0, 0], scale: [1, 1, 1] })],
      ["col", rr.create("constant", { type: "vec4", value: [1, 1, 1, 1] })],
    ]),
    connections: [edge("look", "out", "compose", "rotation")],
    outputBindings: [
      { slot: "particleTransform", from: { nodeId: "compose", socketKey: "out" } },
      { slot: "albedo", from: { nodeId: "col", socketKey: "out" } },
    ],
  });
  return g;
}

/** billboardRender, but the albedo runs through a `lambert-shading` node, so the artifact is lit. */
function litRender(): FXGraph<FXRenderNode> {
  const rr = renderRegistry();
  const g = new FXGraph<FXRenderNode>();
  g.ingest({
    nodes: new Map([
      ["look", rr.create("look-at-camera", { roll: 0 })],
      ["compose", rr.create("compose-transform", { position: [0, 0, 0], scale: [1, 1, 1] })],
      ["col", rr.create("constant", { type: "vec4", value: [1, 1, 1, 1] })],
      ["lit", rr.create("lambert-shading", {})],
    ]),
    connections: [edge("look", "out", "compose", "rotation"), edge("col", "out", "lit", "color")],
    outputBindings: [
      { slot: "particleTransform", from: { nodeId: "compose", socketKey: "out" } },
      { slot: "albedo", from: { nodeId: "lit", socketKey: "color" } },
    ],
  });
  return g;
}

function spawnBehavior(): FXGraph<FXBehaviorNode> {
  const br = behaviorRegistry();
  const g = new FXGraph<FXBehaviorNode>();
  g.ingest({
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
  return g;
}

function compile(render: FXGraph<FXRenderNode>): {
  render: FXRenderArtifact;
  behavior: FXBehaviorArtifact;
} {
  return compileToArtifacts(render, spawnBehavior());
}

/**
 * The self-contained shaders of the artifact's mounted ShaderMaterial (no template, no
 * onBeforeCompile) - built through the real `FXEmitter.fromArtifacts` path (the runtime's only
 * public way to assemble one), not a raw internal `FXArtifactMaterial` construction, so this
 * reflects exactly what the runtime mounts.
 */
function assembled(
  render: FXRenderArtifact,
  behavior: FXBehaviorArtifact,
): { vertexShader: string; fragmentShader: string } {
  const emitter = FXEmitter.fromArtifacts(render, behavior);
  try {
    const mesh = emitter.children[0] as unknown as {
      material: { vertexShader: string; fragmentShader: string };
    };
    return {
      vertexShader: mesh.material.vertexShader,
      fragmentShader: mesh.material.fragmentShader,
    };
  } finally {
    emitter.destroy();
  }
}

describe("mesh vertex epilogue splice", () => {
  it("unlit: assembles the unified epilogue into its ShaderMaterial (no billboard math)", () => {
    const { render, behavior } = compile(billboardRender());
    const { vertexShader } = assembled(render, behavior);

    // The graph's camera-facing transform drives particleTransform...
    expect(render.outputs["particleTransform"]).toBeDefined();
    expect(vertexShader).toContain("mat4 fxParticleXform =");
    expect(vertexShader).toContain(
      "vec3 fxModelPos = particleCenter + (fxParticleXform * (fxVertexXform * vec4(position, 1.0))).xyz;",
    );
    expect(vertexShader).toContain("vec4 mvPosition = viewMatrix * vec4(fxModelPos, 1.0);");
    expect(vertexShader).toContain("gl_Position = projectionMatrix * mvPosition;");
    // look-at-camera reads the view matrix; the old view-space billboard nudge is gone.
    expect(vertexShader).toContain("viewMatrix");
    expect(vertexShader).not.toContain("billboardOffset");
    expect(vertexShader).not.toContain("mvPosition.xy +=");
  });

  it("unlit: identity transforms when the slot is unwired", () => {
    // A render graph binding only albedo leaves both transform slots at identity.
    const rr = renderRegistry();
    const g = new FXGraph<FXRenderNode>();
    g.ingest({
      nodes: new Map([["col", rr.create("constant", { type: "vec4", value: [1, 1, 1, 1] })]]),
      connections: [],
      outputBindings: [{ slot: "albedo", from: { nodeId: "col", socketKey: "out" } }],
    });
    const { render, behavior } = compileToArtifacts(g, spawnBehavior());
    const { vertexShader } = assembled(render, behavior);
    expect(vertexShader).toContain("mat4 fxParticleXform = mat4(1.0);");
    expect(vertexShader).toContain("mat4 fxVertexXform = mat4(1.0);");
  });

  it("lit (lambert-shading node): transforms real mesh normals (no billboard sin/cos)", () => {
    const { render, behavior } = compile(litRender());
    const { vertexShader, fragmentShader } = assembled(render, behavior);
    expect(render.lightingIntrinsics).toEqual(["fxLambertShade"]);
    expect(vertexShader).toContain(
      "mat3 fxNormalXform = mat3(fxParticleXform) * mat3(fxVertexXform);",
    );
    expect(vertexShader).toContain("vec3 objectNormal = fxNormalXform * normal;");
    // The lit material lights up Three's chunks; the shade loop lives in the fxLambertShade intrinsic.
    expect(fragmentShader).toContain("#include <lights_fragment_begin>");
    expect(fragmentShader).toContain("vec4 fxLambertShade(vec4 diffuseColor, vec3 worldNormal) {");
    expect(vertexShader).not.toContain("p_billboardSinCos");
    expect(fragmentShader).not.toContain("p_billboardSinCos");
  });
});
