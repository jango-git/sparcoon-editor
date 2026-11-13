import { describe, expect, it } from "vitest";

import { FXGraph } from "../../src/engine/core/FXGraph";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { stageSource } from "../../src/engine/emit/artifactLiterals";
import type { FXCompiledShader } from "../../src/engine/render/compiler/FXCompiledShader";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import { FXCompilerStandard } from "../../src/engine/render/compiler/FXCompilerStandard";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import {
  buildTrailTarget,
  particleReadsOf,
} from "../../src/engine/render/target/FXParticleRenderTarget";
import { readAttrRender } from "../helpers/attr";

const VEC4 = FX_VALUE_TYPES.vec4;
const FLOAT = FX_VALUE_TYPES.float;
const ATTRIBUTES = [
  { name: "heat", type: VEC4 },
  { name: "width", type: FLOAT },
  { name: "cold", type: VEC4 },
];

/** A trail whose albedo is `heat` (a fragment output, so read there) and whose width is `width`
 *  (a vertex output, so read there), plus `cold`, read by no output. */
function graph(): FXGraph<FXRenderNode> {
  const render = new FXGraph<FXRenderNode>();
  render.ingest({
    nodes: new Map<string, FXRenderNode>([
      ["heat", readAttrRender("heat", VEC4)],
      ["width", readAttrRender("width", FLOAT)],
      ["cold", readAttrRender("cold", VEC4)],
    ]),
    connections: [],
    outputBindings: [
      { slot: "albedo", from: { nodeId: "heat", socketKey: "value" } },
      { slot: "width", from: { nodeId: "width", socketKey: "value" } },
    ],
  });
  return render;
}

describe("particle reads", () => {
  const compilers: [string, (render: FXGraph<FXRenderNode>) => FXCompiledShader][] = [
    [
      "baseline",
      (render) => new FXCompilerBaseline().compile(render, buildTrailTarget(ATTRIBUTES)),
    ],
    [
      "standard",
      (render) => new FXCompilerStandard().compile(render, buildTrailTarget(ATTRIBUTES)),
    ],
  ];

  it.each(compilers)("records what each stage's code reads (%s)", (_, compile) => {
    const shader = compile(graph());
    expect(stageSource(shader.color.vertex).particleReads).toEqual({
      position: false,
      lifecycle: false,
      attributes: ["width"],
    });
    // Not `cold`: no output reaches it, so the compiler never builds it.
    expect(stageSource(shader.color.fragment).particleReads).toEqual({
      position: false,
      lifecycle: false,
      attributes: ["heat"],
    });
    expect(shader.color.vertex.body.join("\n")).toContain("p_fx_width");
    expect(shader.color.fragment.body.join("\n")).not.toContain("p_fx_width");
  });

  it("maps the core builtins and attribute inputs, and nothing else", () => {
    expect(
      particleReadsOf(["PARTICLE_POSITION_Y", "PARTICLE_ID", "p_fx_heat", "p_uv", "u_time"]),
    ).toEqual({ position: true, lifecycle: true, attributes: ["heat"] });
    expect(particleReadsOf(["cameraPosition", "p_cameraDistance"])).toEqual({
      position: false,
      lifecycle: false,
      attributes: [],
    });
  });
});
